/**
 * 转发核心：逐跳头过滤、白名单上游、字节级透传。
 *
 * 为什么不用 fetch：undici 的 fetch 会悄悄解压 gzip 并保留 content-encoding 头，
 * 客户端会收到"声称是 gzip 的明文"，对 API 中继来说这是错误行为。
 * node:http / node:https 不做任何改写，响应体可以原样转发。
 *
 * 其他设计要点：
 * - 响应体用 stream.pipeline 直通，绝不聚合，SSE 才能逐块到达；
 * - 上游 55 秒不返回响应头时主动 504，因为 Faable 在 60 秒会硬切；
 * - 不跟随重定向，避免被上游带到白名单之外的地址。
 */

import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
]);

/**
 * host 由上游决定；expect（100-continue）由 Node 在服务端已自动应答，
 * 继续转给上游会让部分运行时拒绝请求；x-forwarded-* 由这里重写。
 * content-length 保留：字节流没有被改写，长度依然准确。
 */
const DROP_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP,
  'host',
  'expect',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
]);

const NO_BODY_STATUS = new Set([204, 205, 304]);

export function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return;

  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res, status, code, message, extraHeaders = {}) {
  sendJson(res, status, { error: { code, message } }, extraHeaders);
}

function buildRequestHeaders(req, route) {
  const headers = {};

  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || DROP_REQUEST_HEADERS.has(name)) continue;
    headers[name] = value;
  }

  headers.host = route.host;
  headers['x-forwarded-proto'] = 'https';
  if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;

  const clientIp = req.socket.remoteAddress ?? '';
  headers['x-forwarded-for'] = req.headers['x-forwarded-for']
    ? `${req.headers['x-forwarded-for']}, ${clientIp}`
    : clientIp;

  return headers;
}

function pickResponseHeaders(upstreamRes) {
  const headers = {};

  for (const [name, value] of Object.entries(upstreamRes.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    headers[name] = value;
  }

  // 提示中间层不要缓冲；对 SSE 尤其重要，也便于将来在前面加 CDN。
  headers['x-accel-buffering'] = 'no';

  return headers;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{alias: string, protocol: string, hostname: string, port: string, host: string, basePath: string}} route
 * @param {string} rawRest  以 / 开头的原始路径（可为空串），已做穿越校验
 * @param {string} rawQuery 以 ? 开头的原始查询串（可为空串）
 * @param {{headerTimeoutMs: number}} cfg
 * @param {Record<string, string>} extraHeaders 需要合并进响应的头（如 CORS）
 */
export function forward(req, res, route, rawRest, rawQuery, cfg, extraHeaders = {}) {
  return new Promise((resolve) => {
    const targetPath = `${route.basePath}${rawRest}${rawQuery}` || '/';
    const transport = route.protocol === 'https:' ? https : http;

    let settled = false;
    let onClientGone = () => {};
    const finish = () => {
      if (settled) return;
      settled = true;
      res.off('close', onClientGone);
      resolve();
    };

    let timedOut = false;

    const upstreamReq = transport.request({
      protocol: route.protocol,
      hostname: route.hostname,
      port: route.port,
      method: req.method,
      path: targetPath,
      headers: buildRequestHeaders(req, route),
    });

    // 套接字空闲超时：等价于"上游 55 秒没有任何字节"，而不是请求总时长。
    upstreamReq.setTimeout(cfg.headerTimeoutMs, () => {
      timedOut = true;
      upstreamReq.destroy();
    });

    onClientGone = () => {
      if (!res.writableEnded) upstreamReq.destroy();
    };
    res.on('close', onClientGone);

    upstreamReq.on('response', (upstreamRes) => {
      upstreamReq.setTimeout(0);

      if (res.destroyed) {
        upstreamRes.destroy();
        finish();
        return;
      }

      const status = upstreamRes.statusCode ?? 502;
      res.writeHead(status, { ...pickResponseHeaders(upstreamRes), ...extraHeaders });

      const noBody =
        req.method === 'HEAD' ||
        NO_BODY_STATUS.has(status) ||
        upstreamRes.headers['content-length'] === '0';

      if (noBody) {
        upstreamRes.resume();
        res.end();
        finish();
        return;
      }

      pipeline(upstreamRes, res, (error) => {
        if (error && !res.writableEnded) res.destroy();
        finish();
      });
    });

    upstreamReq.on('error', (error) => {
      if (res.headersSent) {
        if (!res.writableEnded) res.destroy();
        finish();
        return;
      }
      if (res.writableEnded || res.destroyed) {
        finish();
        return;
      }

      if (timedOut) {
        sendError(
          res,
          504,
          'upstream_header_timeout',
          `上游在 ${cfg.headerTimeoutMs} ms 内没有返回响应头。` +
            'Faable 在 60 秒会强制切断，所以这里提前给出诊断；' +
            '对 LLM 接口请使用 stream: true。',
          extraHeaders,
        );
      } else {
        sendError(
          res,
          502,
          'upstream_unreachable',
          `无法连接上游：${error.code ?? error.message}`,
          extraHeaders,
        );
      }
      finish();
    });

    if (req.method === 'GET' || req.method === 'HEAD') {
      upstreamReq.end();
      return;
    }

    // 请求体同样原样转发：不缓冲、不改写，大上传也不会占内存。
    req.on('error', () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  });
}
