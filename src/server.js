/**
 * HTTP 入口：路由分发、CORS、探活、访问日志。
 *
 * Faable 会把 PORT 注入环境变量，并要求监听 0.0.0.0。
 */

import http from 'node:http';

import { ConfigError, loadConfig } from './config.js';
import { forward, sendError, sendJson } from './relay.js';

const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

const DEFAULT_PREFLIGHT_HEADERS = [
  'authorization',
  'content-type',
  'accept',
  'accept-encoding',
  'x-api-key',
  'anthropic-version',
  'anthropic-beta',
  'openai-organization',
  'openai-project',
  'openai-beta',
].join(', ');

const SERVICE = 'api-relay';

function corsHeaders(req, cfg) {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (cfg.cors.allowAll) {
    return { 'access-control-allow-origin': '*', vary: 'Origin' };
  }
  if (cfg.cors.origins.has(origin)) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    };
  }
  return {};
}

/**
 * 把原始 URL 解析为路由。prefix 存在时，不在 prefix 下的路径统一"当作不存在"，
 * 不返回 403，避免暴露入口结构。
 */
function resolvePath(rawUrl, cfg) {
  const queryAt = rawUrl.indexOf('?');
  const rawPath = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const rawQuery = queryAt === -1 ? '' : rawUrl.slice(queryAt);

  // 探活始终公开在 /healthz，不随 prefix 变化（平台与外部监控都用得到）。
  if (rawPath === '/healthz') return { kind: 'health' };

  let path = rawPath;

  if (cfg.prefix) {
    const base = `/${cfg.prefix}`;
    if (path === base || path === `${base}/`) return { kind: 'index' };
    if (!path.startsWith(`${base}/`)) return { kind: 'hidden' };
    path = path.slice(base.length);
  }

  if (path === '/healthz') return { kind: 'health' };
  if (path === '/' || path === '') return { kind: 'index' };
  if (!path.startsWith('/')) return { kind: 'hidden' };

  const rest = path.slice(1);
  const slash = rest.indexOf('/');
  const alias = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  const rawRest = slash === -1 ? '' : rest.slice(slash);

  if (!alias) return { kind: 'hidden' };

  return { kind: 'relay', alias, rawRest, rawQuery };
}

/** 拒绝路径穿越与控制字符；合法的编码（如 %2F）保持原样转发。 */
function isUnsafePath(rawRest) {
  if (!rawRest) return false;
  if (rawRest.includes('\\')) return true;

  let decoded;
  try {
    decoded = decodeURIComponent(rawRest);
  } catch {
    return true;
  }

  if (/[\u0000-\u001f\u007f]/.test(decoded)) return true;

  return decoded.split('/').includes('..');
}

function createHandler(cfg) {
  return async function handler(req, res) {
    const requestStart = process.hrtime.bigint();
    const rawPath = (req.url ?? '/').split('?')[0];
    // 访问日志也不写入访问前缀本身（查询串本来就不记录）。
    const logPath = cfg.prefix ? rawPath.replace(`/${cfg.prefix}`, '/<prefix>') : rawPath;

    res.once('finish', () => {
      const ms = Number(process.hrtime.bigint() - requestStart) / 1e6;
      console.log(
        JSON.stringify({
          time: new Date().toISOString(),
          method: req.method,
          path: logPath,
          status: res.statusCode,
          ms: Math.round(ms),
        }),
      );
    });

    const cors = corsHeaders(req, cfg);
    for (const [name, value] of Object.entries(cors)) {
      res.setHeader(name, value);
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': ALLOWED_METHODS.join(', '),
        'access-control-allow-headers':
          req.headers['access-control-request-headers'] || DEFAULT_PREFLIGHT_HEADERS,
        'access-control-max-age': '86400',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    if (!ALLOWED_METHODS.includes(req.method)) {
      sendError(res, 405, 'method_not_allowed', `不支持的方法：${req.method}`, {
        allow: ALLOWED_METHODS.join(', '),
        ...cors,
      });
      return;
    }

    const rawUrl = req.url ?? '/';
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
      sendError(res, 400, 'absolute_form_rejected', '不支持绝对形式请求行，请使用路径形式。', cors);
      return;
    }

    const route = resolvePath(rawUrl, cfg);

    if (route.kind === 'hidden') {
      sendError(res, 404, 'not_found', 'Not found', cors);
      return;
    }

    // 探活与首页都只返回固定信息，不回显任何 alias、上游地址或访问前缀。
    if (route.kind === 'health') {
      sendJson(res, 200, { ok: true, service: SERVICE });
      return;
    }

    if (route.kind === 'index') {
      sendJson(res, 200, { service: SERVICE, status: 'ok' });
      return;
    }

    if (isUnsafePath(route.rawRest)) {
      sendError(res, 400, 'invalid_path', '路径包含非法字符或 .. 片段。', cors);
      return;
    }

    const upstream = cfg.routes.get(route.alias);
    if (!upstream) {
      sendError(res, 403, 'route_not_allowed', '请求的路径不在允许的范围内。', cors);
      return;
    }

    await forward(req, res, upstream, route.rawRest, route.rawQuery, cfg, cors);
  };
}

function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      console.error('启动失败：请检查环境变量（见 .env.example）。');
      process.exit(1);
    }
    throw error;
  }

  const handler = createHandler(cfg);

  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      console.error('[relay] 未处理的错误', error);
      if (!res.headersSent) {
        sendError(res, 500, 'internal_error', '中继内部错误');
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });
  });

  // 上游可能很慢，但 Faable 的 60 秒限制作用在响应头上，这里放宽连接级超时。
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  server.on('clientError', (_error, socket) => {
    socket.destroy();
  });

  server.listen(cfg.port, '0.0.0.0', () => {
    console.log(
      JSON.stringify({
        event: 'listening',
        port: cfg.port,
        routes: cfg.routes.size,
        prefix: Boolean(cfg.prefix),
        cors: cfg.cors.allowAll ? '*' : cfg.cors.origins.size,
        headerTimeoutMs: cfg.headerTimeoutMs,
      }),
    );
  });

  const shutdown = (signal) => {
    console.log(JSON.stringify({ event: 'shutdown', signal }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
