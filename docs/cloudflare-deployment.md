# 部署到 bgp.thanejoss.com

本项目部署为三个 Cloudflare **Workers**。网页使用 Vinext / Vite 构建，BGP 查询使用独立 Worker 读取 R2。RouteViews 数据下载、MRT 解析与路径库构建都在 GitHub Actions runner 执行，发布 Worker 通过原生 R2 binding 接收 GitHub runner 上传的生成结果，R2 桶 `route-atlas-bgp` 保存这些结果。Cloudflare 的前端构建会安装 npm/pnpm 依赖，不会下载或解析原始路由数据。

| 请求 | Worker | 配置 |
| --- | --- | --- |
| `https://bgp.thanejoss.com/` 和静态资源 | `bgp` | 根目录 `wrangler.jsonc` |
| `https://bgp.thanejoss.com/api/bgp/*` | `route-atlas-bgp` | `workers/bgp/wrangler.jsonc` |
| GitHub Actions 私有发布入口（workers.dev，所有请求均需 token） | `route-atlas-bgp-publisher` | `workers/bgp-publisher/wrangler.jsonc` |

网页 Worker 绑定 Custom Domain；查询 Worker 绑定同一域名的路径 Route。
[Cloudflare 的 Route 优先于同域名的 Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/routes/)，所以 API 不经过网页 SSR Worker。

## 账户前置条件

1. `thanejoss.com` 已是部署账户中的 active Cloudflare zone。
2. `bgp.thanejoss.com` 没有与目标部署冲突的现有站点或 CNAME；若已有服务，先安排迁移。
3. 同一账户已开通 R2，并准备好专用桶 `route-atlas-bgp`。若使用其他桶名，同时修改查询与发布 Worker 的 `bucket_name` 和 GitHub 数据任务的 `R2_BUCKET`。

[Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) 会由 Cloudflare 创建 DNS 记录和证书。先部署网页，再部署 API Route。无需手动把 `bgp` CNAME 指向 `workers.dev`。

R2 是包含免费额度的按用量计费服务。若账户已有 R2、且需要创建这个专用桶，可明确执行：

```sh
pnpm exec wrangler r2 bucket create route-atlas-bgp
```

部署命令不会创建桶、启用计费订阅或下载 BGP 数据。

## 本地部署

需要 Node.js 22.13+ 和仓库指定的 pnpm 11.25.0。在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler whoami
```

确认登录的是持有 `thanejoss.com` 和 R2 桶的账户；多账户情况下设置 `CLOUDFLARE_ACCOUNT_ID` 选择账户。随后：

```sh
pnpm run deploy
```

该命令依次完成：

1. `vite build` 构建网页及静态资源。
2. `wrangler deploy --config dist/server/wrangler.json` 使用 Vite 生成的部署配置发布 `bgp` 并绑定域名。
3. `wrangler deploy --config workers/bgp/wrangler.jsonc` 发布 `route-atlas-bgp` 并绑定 API Route。
4. `wrangler deploy --config workers/bgp-publisher/wrangler.jsonc` 发布独立的 R2 发布入口。

这三个 Worker 的部署不是原子操作。如果第二步部署的网页已经成功，而查询 Worker 部署失败，解决 R2 或路由问题后单独重试 `pnpm run bgp:worker:deploy`。

单独更新网页运行 `pnpm run deploy:web`；单独更新查询服务运行 `pnpm run bgp:worker:deploy`；单独更新发布入口运行 `pnpm run bgp:publisher:deploy`。

根目录 `wrangler.jsonc` 是 Vite 的输入配置，`assets.directory` 由 Cloudflare Vite 插件写入生成的配置。
不要跳过构建直接部署未打包的 Vinext 入口，也不要把整个仓库作为静态文件上传。

## Cloudflare Workers Builds 连接 GitHub

如果希望推送 `main` 后自动部署网页和查询服务，可以分别创建两个 Workers Builds 项目，连接 `ThaneJoss/bgp`：

| 设置 | 网页 | BGP API |
| --- | --- | --- |
| Worker 名称 | `bgp` | `route-atlas-bgp` |
| 生产分支 | `main` | `main` |
| 根目录 | `/` | `/` |
| 构建命令 | `pnpm run build:cloudflare` | 留空 |
| 部署命令 | `pnpm exec wrangler deploy --config dist/server/wrangler.json` | `pnpm exec wrangler deploy --config workers/bgp/wrangler.jsonc` |
| 非生产分支部署命令 | `pnpm exec wrangler versions upload --config dist/server/wrangler.json` | `pnpm exec wrangler versions upload --config workers/bgp/wrangler.jsonc` |

构建环境通过仓库的 `.node-version` 使用 Node.js 22.23.2。在两个 Builds 项目的 **Settings → Build → Build variables and secrets** 设置 `PNPM_VERSION=11.25.0` 和 `SHARP_IGNORE_GLOBAL_LIBVIPS=1`，安装依赖时使用锁文件。后者让 sharp 使用其预编译依赖，避免构建镜像自带的 libvips 改变安装行为。Cloudflare 支持的工具版本选择方式见[构建镜像文档](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)。

本项目的网页使用 Vinext，按表格设置构建和部署命令。控制台若按 `next` 依赖自动填入 OpenNext 的构建命令，需要替换为 `pnpm run build:cloudflare`。部署明确读取 `dist/server/wrangler.json`，避免 Wrangler 在缺少输入配置时自动选择 OpenNext。出现 `pnpm opennextjs-cloudflare build` 后找不到 `.next/server/middleware-manifest.json` 的错误，说明使用了错误的构建适配器：Vinext 的产物在 `dist/`，不会生成 OpenNext 所需的 `.next/` manifest。首次先完成网页部署，确保域名 DNS 已创建，再部署 API。每个 Builds 项目只部署对应 Worker；本地使用的组合命令 `pnpm run deploy` 不用于这两个项目的部署命令。

发布入口可用 `pnpm run bgp:publisher:deploy` 单独更新；若为它连接 Workers Builds，构建命令留空，部署命令使用 `pnpm exec wrangler deploy --config workers/bgp-publisher/wrangler.jsonc`。

`.github/workflows/site-checks.yml` 会在 PR 和 `main` 推送时安装锁定依赖、构建完整网页，用本地 R2 binding 测试发布入口，并对三个 Worker 执行 Wrangler dry-run；日志可直接在 GitHub Actions 查看。这个检查不需要 Cloudflare 或 R2 凭据，也不下载原始 BGP 数据。

日志中的 `downloaded 628` 是 npm/pnpm 依赖包数量，`postinstall: Done` 表示对应依赖安装完成。`build ssr environment` 和路由表说明源码构建已经完成。若之后失败，需要检查紧接着的 Wrangler 部署报错；这些日志本身不能说明数据采集失败。

`.openai/hosting.json` 是已有托管元数据；个人 Cloudflare 部署使用 Wrangler 配置和自己的账户。

## 首次路径数据发布

网页可部署成功而查询库仍为空。要启用真实路径查询，按 [BGP 数据任务说明](bgp/ci.md) 配置：

- R2 桶：`route-atlas-bgp`，查询与发布 Worker 均绑定为 `BGP_BUCKET`。
- 发布 Worker Secret：`INGEST_TOKEN`，通过 `pnpm exec wrangler secret put INGEST_TOKEN --config workers/bgp-publisher/wrangler.jsonc` 设置。
- GitHub Variables：`R2_BUCKET=route-atlas-bgp`、`R2_PUBLISH_URL`（发布 Worker 的 HTTPS 地址）。
- GitHub Secret：`R2_PUBLISH_TOKEN`，与 `INGEST_TOKEN` 使用相同值。无需 R2 S3 access key 或 secret key。
- 首次手动运行 `BGP daily snapshot`，可选填 UTC 快照日期；留空使用当天的 00:00 UTC RIB。

数据任务每天 03:17 UTC 自动运行，无需额外启用变量或确认勾选。缺少上述 GitHub 配置时会在下载前失败；本地 Wrangler 已登录不代表 GitHub runner 已配置 R2 凭据。Worker 部署不会触发数据任务。发布入口只处理已生成对象的传输；超过 64 MiB 的文件由 runner 分片上传，再通过 R2 流式合成为完整对象，查询 Worker 继续读取原有格式。

全球拓扑使用仓库中已提交的 CAIDA 静态快照，当前未配置 CAIDA 自动更新 workflow；前端构建直接打包该快照。

`public/bgp-service.json` 的 `apiBase` 保持空字符串，查询服务的 `APP_ORIGIN` 已设为 `https://bgp.thanejoss.com`。只有域名绑定 API Route 后，该同源配置才会访问查询 Worker；网页的 `workers.dev` 预览地址仍会返回未接通的 API fallback。

## 验证

不发布到云端的构建和打包检查：

```sh
pnpm run build:cloudflare
pnpm exec wrangler deploy --config dist/server/wrangler.json --dry-run
pnpm exec wrangler deploy --config workers/bgp/wrangler.jsonc --dry-run
pnpm exec wrangler deploy --config workers/bgp-publisher/wrangler.jsonc --dry-run
pnpm run bgp:publisher:test
```

部署后检查：

```sh
curl -I https://bgp.thanejoss.com/
curl -i https://bgp.thanejoss.com/api/bgp/manifest
```

首页应返回 200，静态拓扑数据应能加载。首份数据发布后，manifest 应返回 200 和可用 peer；空桶时 API 返回 503 属于尚未发布数据。若响应是网页 fallback 的“离线路径库尚未接通”，应检查 API Route 是否成功绑定。

这些步骤不证明查询满足 Cloudflare Free 的 CPU 限额；线上 CPU 验收仍按 [预算说明](worker-free-budget.md) 执行。
