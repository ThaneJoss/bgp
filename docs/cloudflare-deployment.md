# Cloudflare 部署

本项目只需要一个提供网页和原始数据流转发的 Worker，无需数据库或对象存储。

## 构建与部署

```sh
pnpm install --frozen-lockfile
pnpm run bgp:test
pnpm exec tsc --noEmit
pnpm exec wrangler deploy --dry-run
pnpm run deploy
```

根目录 `wrangler.jsonc` 通过 custom build 生成 Vinext/Vite 产物；Vite 使用 `wrangler.vite.jsonc` 的源入口。域名仍为 `bgp.thanejoss.com`。

| 入口 | 行为 |
| --- | --- |
| `/`、`/paths` 和静态资源 | 网页；首次打开不获取数据 |
| `/api/bgp/download?date=YYYY-MM-DD` | 用户点击后转发固定 HKIX 00:00 UTC 原始 RIB 字节流 |
| 旧 `/api/bgp/manifest`、`/api/bgp/compare`、`/_ingest/*` | 410，已停止查询/上传服务 |

下载入口不接受任意 URL，跟随重定向被禁用，响应为 `Cache-Control: no-store`。上游 404 提示选择更早日期；网络错误可以重试或改用本地导入。

## 从旧版迁移

合并新版本后，每日采集 workflow 被删除；部署新版本后，查询与上传入口停用、R2 binding 移除。旧的数据库/R2 数据及 Cloudflare/GitHub Secrets 不会被代码删除，也不再被使用。可以在确认新版工作后自行清理原有资源。不要继续运行旧分支中的发布 workflow。

仍需检查自定义域名没有被旧 Worker Route 截获。无需设置 `R2_BUCKET`、`R2_PUBLISH_URL`、`R2_PUBLISH_TOKEN` 或 `INGEST_TOKEN`。

Workers Builds 如已配置，可以保留安装和 `pnpm run deploy` 命令。网站构建/部署与 BGP 数据采集无关，不会下载路由数据。

## 验收

打开 `/paths`，确认未点击前没有数据请求。点击获取后有进度，取消停止下载/解析；完成后可选择 session 查询 IPv4/IPv6。重新获取失败时旧数据仍可查询；刷新后回到未加载状态。本地导入应不产生文件上传请求。

转发入口需要运行 Worker。只托管静态文件时，仍可使用「下载原始文件」和「导入本地文件」，自动转发下载不可用。
