# api-relay

一个**域名白名单 API 中继**，部署在 [Faable Deploy](https://faable.com/docs/deploy) 上，用于把某个 API 域名（例如 `api.openai.com`）通过自己的域名中转出去。

- 零依赖：只用 Node 内置的 `http` + `fetch`（undici），构建产物几百 KB
- **SSE / 流式响应原样透传**，不缓冲、不解压、不聚合
- 上游只能来自环境变量里的白名单，请求里**不接受任何 URL**，因此不是开放中继（Faable ToS 明确禁止开放中继）
- 不保存任何上游凭据：客户端的 `authorization` / `x-api-key` 原样转发

## 路由规则

```
GET|POST https://<app>.faable.link/<alias>/<path>[?query]
```

`<alias>` 在 `ROUTES` 中登记，映射到固定的上游源站：

```bash
ROUTES=openai=https://api.openai.com,anthropic=https://api.anthropic.com,custom=https://ai.example.com/v1
```

| 请求 | 实际转发到 |
| --- | --- |
| `/openai/v1/chat/completions` | `https://api.openai.com/v1/chat/completions` |
| `/anthropic/v1/messages` | `https://api.anthropic.com/v1/messages` |
| `/custom/chat` | `https://ai.example.com/v1/chat` |

未登记的 alias 返回 `403`（不回显清单内容）；路径里的 `..`、反斜杠、控制字符返回 `400`。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `ROUTES` | ✅ | — | `alias=https://host[/base]`，逗号分隔；只允许 http/https，不允许带账号密码或查询串 |
| `ALLOW_ORIGINS` | | 空 | 允许的浏览器来源，逗号分隔；`*` 表示任意。留空则不下发 CORS 头（只适合服务端调用） |
| `ROUTE_PREFIX` | | 空 | 不可猜的访问前缀（6–64 字符）。设置后入口变为 `/<ROUTE_PREFIX>/<alias>/<path>`，其余路径（`/healthz` 除外）一律 404 |
| `UPSTREAM_HEADER_TIMEOUT_MS` | | `55000` | 等待上游响应头的超时，强制 ≤ 59000（见下文） |
| `PORT` | | 平台注入 | 监听端口，绑定 `0.0.0.0` |

本地开发把变量写进 `.env` 后手动导出，或直接：

```bash
ROUTES=openai=https://api.openai.com node src/server.js
```

## 部署到 Faable

方式一（推荐，Git 自动部署）：

1. Dashboard 建 **Project** → **App** → **Link repository** 选中本仓库
2. 在 App 的环境变量里配置 `ROUTES`（以及可选的 `ALLOW_ORIGINS` / `ROUTE_PREFIX`）
3. push 到部署分支，访问 `https://<app>.faable.link/healthz`

方式二（本地命令行）：

```bash
npm i -g @faable/faable
faable login
faable deploy link          # 绑定仓库到 app，会写入 faable.json 的 app_id/app_slug
faable deploy
faable deploy secrets set ROUTES='openai=https://api.openai.com' ROUTE_PREFIX='<随机串>'
```

`faable.json` 已固定 `buildpack: node` 与 `startCommand`，Free 套餐即可构建（不需要 Docker）。

## 调用示例

非流式：

```bash
curl -s https://<app>.faable.link/openai/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

流式（LLM 必须这样用，原因见下文）：

```bash
curl -sN https://<app>.faable.link/openai/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

`-N` 关闭 curl 自己的缓冲，能直接看到分块到达。

浏览器里调用时，把 `ALLOW_ORIGINS` 设为你的前端来源，中继会自动应答 `OPTIONS` 预检。

## 必须知道的平台限制

| 限制 | 影响 | 应对 |
| --- | --- | --- |
| **60 秒内必须返回响应头** | 非流式长生成会 504 | 中继在 55 秒时自己返回 `504 upstream_header_timeout` 并说明原因；调用方使用 `stream: true` |
| 响应体时长不限，SSE 不缓冲 | — | 正常透传即可，无需自己加心跳 |
| Free：10 GB egress/月（1 GB/天） | 只适合文本类 API | 中转音频/文件会很快撞线，需要 Hobby（50 GB）或 Pro |
| Free：空闲 30 分钟休眠 | 冷启动几秒会计入 TTFB | 要 7×24 常驻请用 Hobby（常驻 + Docker + 1.5 GB 内存） |
| Free：未来每天强制休眠 4 小时 | 不适合生产 | 同上 |
| 单来源 IP 600 req/min（Free） | 所有流量来自一台机器时会 429 | 提高套餐或分散出口 |
| Free：仅 Node/Python/PHP buildpack | 不能自定义 Docker | 本项目不需要 Docker |

## 安全模型

- **白名单在服务端**：请求只能选 alias，无法构造任意目标，不存在 SSRF 或开放中继。
- **不存密钥**：上游凭据由调用方通过 `authorization` / `x-api-key` 传入，中继不读取、不记录、不落盘。
- **不做访问控制**：任何拿到 URL 的人都能使用这条通道。若不想公开，设置 `ROUTE_PREFIX`（不可猜前缀）而不是登录；真正需要身份时，建议在 Faable Auth 或前置网关做。
- **不跟随重定向**：上游 3xx 原样返回，避免被引导到白名单之外的地址。
- **响应不外泄配置**：`/`、`/healthz` 和所有错误响应都只返回固定文本，不回显 alias、上游域名、`ROUTE_PREFIX` 或环境变量值；访问日志中对前缀做脱敏。
- 只中转你有权访问的 API，并遵守上游的服务条款。

## 故障排查

| 现象 | 原因 |
| --- | --- |
| 启动即退出，日志 `[config] ...` | 环境变量非法，按提示修正 `ROUTES` |
| `403 route_not_allowed` | alias 拼错或没在 `ROUTES` 里 |
| `404 not_found` | 设置了 `ROUTE_PREFIX` 但请求没带前缀（或前缀不对）；`/healthz` 始终公开 |
| `504 upstream_header_timeout` | 上游 55 秒没给响应头；LLM 请求请用 `stream: true` |
| `502 upstream_unreachable` | 上游域名解析/连接失败，检查 alias 的 host |
| 浏览器报 CORS | `ALLOW_ORIGINS` 没包含该来源 |
| 访问 `/` 只看到 `{service, status}` | 正常；索引页有意不返回路由配置 |
