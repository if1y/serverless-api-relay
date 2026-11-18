/**
 * 配置加载与校验。
 *
 * 所有上游都来自环境变量，请求中不接受任何 URL —— 这是避免 SSRF 和
 * "开放中继"（Faable ToS 明确禁止）的关键设计。
 */

const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PREFIX_RE = /^[A-Za-z0-9._~-]{6,64}$/;

export class ConfigError extends Error {}

function fail(message) {
  throw new ConfigError(`[config] ${message}`);
}

function parseRoutes(raw) {
  const text = (raw ?? '').trim();
  if (!text) {
    fail('缺少 ROUTES，例如 openai=https://api.openai.com');
  }

  const routes = new Map();

  for (const entry of text.split(',')) {
    const item = entry.trim();
    if (!item) continue;

    const eq = item.indexOf('=');
    if (eq <= 0) {
      fail(`ROUTES 条目格式应为 alias=https://host[/base]，收到：${item}`);
    }

    const alias = item.slice(0, eq).trim().toLowerCase();
    const target = item.slice(eq + 1).trim();

    if (!ALIAS_RE.test(alias)) {
      fail(`非法 alias "${alias}"：只允许小写字母、数字、- 和 _，最长 32 个字符`);
    }
    if (routes.has(alias)) {
      fail(`重复的 alias：${alias}`);
    }

    let url;
    try {
      url = new URL(target);
    } catch {
      fail(`alias "${alias}" 的上游不是合法 URL：${target}`);
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      fail(`alias "${alias}" 只支持 http/https，收到：${url.protocol}`);
    }
    if (url.username || url.password) {
      fail(`alias "${alias}" 的上游不能包含账号密码，请改用请求头传递凭据`);
    }
    if (url.search || url.hash) {
      fail(`alias "${alias}" 的上游不能包含查询串或锚点`);
    }

    const basePath = url.pathname.replace(/\/+$/, '');
    routes.set(alias, {
      alias,
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (url.protocol === 'https:' ? '443' : '80'),
      host: url.host,
      basePath,
      label: `${url.origin}${basePath}`,
      insecure: url.protocol === 'http:',
    });
  }

  if (routes.size === 0) {
    fail('ROUTES 里没有任何有效条目');
  }

  return routes;
}

function parseCors(raw) {
  const text = (raw ?? '').trim();
  if (!text) return { allowAll: false, origins: new Set() };

  const items = text
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (items.includes('*')) return { allowAll: true, origins: new Set() };

  const origins = new Set();
  for (const item of items) {
    let url;
    try {
      url = new URL(item);
    } catch {
      fail(`ALLOW_ORIGINS 中含非法来源：${item}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      fail(`ALLOW_ORIGINS 只支持 http/https 来源：${item}`);
    }
    origins.add(url.origin);
  }

  return { allowAll: false, origins };
}

function parseTimeout(raw) {
  if (raw === undefined || raw === '') return 55_000;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    fail(`UPSTREAM_HEADER_TIMEOUT_MS 不是数字：${raw}`);
  }
  if (value < 1000 || value > 59_000) {
    fail('UPSTREAM_HEADER_TIMEOUT_MS 必须在 1000–59000 之间（Faable 在 60 秒时切断请求）');
  }
  return Math.floor(value);
}

function parsePrefix(raw) {
  const value = (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!value) return '';
  if (!PREFIX_RE.test(value)) {
    fail('ROUTE_PREFIX 只允许字母、数字、. _ ~ -，长度 6–64');
  }
  return value;
}

export function loadConfig(env = process.env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail(`PORT 非法：${env.PORT}`);
  }

  const routes = parseRoutes(env.ROUTES);

  for (const route of routes.values()) {
    if (route.insecure) {
      console.warn(`[config] 警告：alias "${route.alias}" 使用明文 http，凭据会暴露在链路上`);
    }
  }

  return {
    port,
    routes,
    prefix: parsePrefix(env.ROUTE_PREFIX),
    cors: parseCors(env.ALLOW_ORIGINS),
    headerTimeoutMs: parseTimeout(env.UPSTREAM_HEADER_TIMEOUT_MS),
  };
}
