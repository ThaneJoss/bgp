# 部署到 bgp.thanejoss.com

项目部署为单个 Cloudflare **Worker `bgp`**。网页使用 Vinext / Vite 构建，统一入口处理网页、BGP 查询和认证上传。R2 桶 `route-atlas-bgp` 通过原生 `BGP_BUCKET` binding 保存已生成的数据。

| 请求 | 处理方式 |
| --- | --- |
| `/` 和静态资源 | 网页与静态资源 |
| `/api/bgp/*` | 直接调用 BGP 查询 handler，读取 R2 |
| `/_ingest/*` | 校验 `INGEST_TOKEN`，接收 GitHub runner 的对象上传 |

RouteViews 下载、MRT 解析、索引及 diff 生成仍全部在 GitHub Actions runner 执行。认证上传入口只传输生成对象，不下载或解析上游 RIB。CAIDA 拓扑保持仓库内的静态快照。构建日志中的 npm/pnpm `downloaded` 是依赖安装，不是路由数据采集。

## 账户与迁移

1. `thanejoss.com` 是部署账户中的 active zone，Worker `bgp` 使用 Custom Domain `bgp.thanejoss.com`。
2. 保留 R2 桶 `route-atlas-bgp`，根目录 Wrangler 配置将它绑定为 `BGP_BUCKET`。
3. 从旧 Worker `route-atlas-bgp` 解除 `bgp.thanejoss.com/api/bgp/*` Route。[Route 优先于同域名的 Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/routes/)，不解除就会继续进入旧服务。
4. 旧 `route-atlas-bgp` 与 `route-atlas-bgp-publisher` 两个 Worker 由用户自行删除。**不要删除同名 R2 桶 `route-atlas-bgp`**，其中保存已发布路径数据。

新配置只部署 `bgp`，不再需要独立 API Route。[Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) 由 Cloudflare 管理 DNS 与证书。R2 属于按用量计费服务；部署不会新建桶或启用计费订阅。

## 构建与部署

需要 Node.js 22.13+ 和仓库指定的 pnpm 11.25.0。先安装锁定依赖并确认 Wrangler 账户：

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler whoami
```

根目录 `wrangler.jsonc` 是可直接执行的部署配置，入口为 `dist/server/index.js`，静态资源目录为 `dist/client`。它的 custom build 自动执行 Vite 构建。`wrangler.vite.jsonc` 指定源码入口，`vite.config` 从根配置取得运行时 bindings，构建出统一 Worker。

```sh
pnpm run deploy
# 上传非生产预览版本
pnpm run preview:cloudflare
```

两条脚本分别执行根配置的 `wrangler deploy` 和 `wrangler preview`，都会先运行 custom build。若只检查构建和打包，不发布到云端：

```sh
pnpm exec wrangler deploy --dry-run
```

也可显式执行 `pnpm run build:cloudflare`，然后使用 `pnpm exec wrangler deploy --config dist/server/wrangler.json` 部署对应生成配置。上述方式都只部署 `bgp`。

本次变更通过新 PR 审查，部署可以使用 PR 分支的代码；部署成功不表示 PR 已合并。不要把 PR 部署状态写成 `main` 已更新。

## Workers Builds 的错误原因

`pnpm opennextjs-cloudflare build` 后缺少 `.next/server/middleware-manifest.json`，是控制台选用了错误的框架适配器。本项目使用 Vinext / Vite，产物在 `dist/`，并不生成 OpenNext 所需的 `.next/` manifest。

`npx wrangler preview` 会在执行 custom build **之前**校验静态资源目录。因此，仅添加构建命令仍不足以支持干净 checkout。根配置现在明确设置 `assets.directory=dist/client`，安装依赖的 `postinstall` 只调用 `scripts/prepare-build.mjs` 创建这个空目录，使前置校验通过；随后 custom build 真正生成网页和 Worker，构建成功后才上传。`postinstall` 不编译网站，也不下载 BGP 数据。

Workers Builds 只需连接 `ThaneJoss/bgp` 的 `bgp` 项目，根目录保持 `/`：

| 设置 | 值 |
| --- | --- |
| 构建命令 | 留空，Wrangler custom build 会自动构建 |
| 生产部署命令 | `npx wrangler deploy` |
| 非生产分支部署命令 | `npx wrangler preview` |

保留这些控制台命令即可使用仓库根配置，无需独立查询或上传 Worker 的构建项目。

构建环境使用仓库 `.node-version`，设置 `PNPM_VERSION=11.25.0` 和 `SHARP_IGNORE_GLOBAL_LIBVIPS=1`，依赖安装使用锁文件。工具版本设置见[构建镜像文档](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)。

`.github/workflows/site-checks.yml` 通过 `pnpm exec wrangler deploy --dry-run` 自动完整构建并检查统一 Worker 部署包，另行测试统一路由和上传 handler 的本地 R2 行为。检查不需要生产凭据，也不下载原始 BGP 数据。

## 数据发布配置

按 [BGP 数据任务说明](bgp/ci.md) 配置以下内容：

| 位置 | 名称 | 值 |
| --- | --- | --- |
| `bgp` Worker Secret | `INGEST_TOKEN` | 仅存于 Secrets 的上传口令 |
| GitHub Variable | `R2_BUCKET` | `route-atlas-bgp` |
| GitHub Variable | `R2_PUBLISH_URL` | `https://bgp.thanejoss.com/_ingest` |
| GitHub Secret | `R2_PUBLISH_TOKEN` | 与 `INGEST_TOKEN` 相同 |

```sh
pnpm exec wrangler secret put INGEST_TOKEN --config wrangler.jsonc
```

无需 S3 access key 或 secret key。不要在代码、命令参数或日志里保存口令。超过 64 MiB 的文件由 runner 分片上传，再通过 R2 流式合成为完整对象；查询继续读取原有文件格式。

`BGP daily snapshot` 每天 03:17 UTC 执行，也可手动选择 UTC 快照日期，留空使用当天 00:00 UTC RIB。缺少 GitHub 配置会在下载前失败。Wrangler 登录不会自动配置 GitHub Secrets；Worker 部署本身不会触发数据任务。

## 验证

部署后检查首页和路径库：

```sh
curl -I https://bgp.thanejoss.com/
curl -i https://bgp.thanejoss.com/api/bgp/manifest
curl -i https://bgp.thanejoss.com/_ingest/objects
```

首页应返回 200。已有数据时 manifest 应返回 200 与可用 peer；空桶返回 503 表示尚未发布路径库。没有认证信息的上传请求应返回 401。GitHub runner 使用 Secret 验证认证上传，不应在公开日志打印认证请求头。

`public/bgp-service.json` 保持 `{"apiBase":""}` 使用同源查询。验证时需要确认查询请求进入统一 `bgp`，而非仍被旧 API Route 截获。这些功能检查不证明 CPU 限额达标；真实 CPU 验收按 [预算说明](worker-free-budget.md) 筛选查询请求独立执行。

`.openai/hosting.json` 是已有托管元数据；本项目的个人 Cloudflare 部署使用 Wrangler 配置及自己的账户。
