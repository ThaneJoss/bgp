# bgp / AS Atlas

AS Atlas 展示全球 AS 拓扑，并在**用户浏览器内**解析 RouteViews 原始数据、比较两个目标 IP 的 BGP 观测路径。项目不使用数据库、R2 路径库或 CI 数据更新任务。

## 使用

1. 全球拓扑页点击「获取拓扑数据」，浏览器读取仓库中现有的 CAIDA JSON 快照，再按需加载图块。
2. 路径对比页选择 UTC 日期，点击「获取数据」。默认选择昨天的 00:00 UTC RIB，避免当天文件尚未生成。
3. 浏览器下载 HKIX `.bz2` 原始文件，在 Web Worker 中逐块解压、解析 MRT，并建立内存中的路由索引。页面显示读取量、记录数和路由数，可随时取消。
4. 解析完成后输入两个 IP、选择同一个真实观测 session，在浏览器内执行最长前缀匹配并绘图。查询不会向服务器发送目标 IP。
5. 也可以点击「下载原始文件」，再「导入本地文件」。支持 `.bz2`、`.gz` 和未压缩 MRT；导入文件不会上传。

页面首次打开不会下载路由或拓扑数据。没有定时刷新、后台更新、IndexedDB 或 localStorage 数据库。成功加载的数据仅保留在当前页面内存中；站内页签切换保留它，浏览器刷新或关闭页面后清除。重新获取失败或取消时，继续保留当前已加载的数据。

原始 RIB 较大，流量、CPU 和索引内存由用户设备承担。压缩输入限制 1 GiB，解压输入限制 8 GiB，单条 MRT 记录限制 64 MiB，索引最多保存 200 万条路由及 400 万个去重路径 ASN。低内存设备可能需要改用桌面浏览器。

## 为什么有下载转发入口

RouteViews 原站的 CORS 响应只允许其指定的 MRT Explorer 域。本站使用 `GET /api/bgp/download?date=YYYY-MM-DD` **按需转发原始响应流**，让浏览器可以读取字节。服务端只允许固定 HKIX 归档地址，不接受任意 URL；没有解压、MRT 解析、查询、缓存或持久化。

所有下载均由按钮触发。构建和 CI 测试只使用合成数据，不下载真实 BGP 数据。

## 数据范围

- RouteViews **hkix.hkg / 香港 HKIX**，保留 AS3491 Console Connect/PCCW 的两个 session：`123.255.90.244` 和 `2001:7fa:0:1::ca28:a0f4`。
- 两个 session 分开处理，不会合并成虚构的双栈 peer；缺失地址族会明确显示。
- 展示的是该观测 session 到目标前缀的 AS_PATH，不是两个 IP 之间的 traceroute。香港采集器不代表中国大陆内部视角。
- 支持 TABLE_DUMP_V2 IPv4/IPv6 unicast、RIB_GENERIC 和 ADDPATH。连续重复 ASN 仅在绘图时合并。
- AS_SET、confederation、未解决的 AS_TRANS 或冲突 ADDPATH 标记为 `unsupported_path`，仍遮盖较短前缀，不会错误回退。
- 文件完全解析并通过结构/压缩 CRC 检查后才切换数据；显示的数据时间取自 MRT 文件头。
- CAIDA 拓扑仍是仓库中标注日期的静态快照。按钮加载该快照，不会重新采集 CAIDA 原始关系数据。

## 开发与验证

需要 Node 22.13+、pnpm 11 和 Python 3（仅生成压缩测试样本）。

```sh
pnpm install --frozen-lockfile
pnpm run bgp:test
pnpm exec tsc --noEmit
node scripts/verify-functional.mjs
pnpm run dev
pnpm run build:cloudflare
```

| 路径 | 用途 |
| --- | --- |
| `components/bgp-data-controls.tsx` | 获取、日期、进度、取消、本地导入 |
| `lib/bgp-client.ts` | 浏览器 Worker 生命周期、原子切换与本地查询 |
| `lib/bgp/browser-worker.mjs` | 浏览器下载、解析与查询消息入口 |
| `lib/bgp/streams.mjs` / `load.mjs` | 流式读取与 bzip2/gzip 解压 |
| `lib/bgp/mrt.mjs` / `ip.mjs` | MRT 解析、session 筛选与 IPv4/IPv6 LPM |
| `lib/bgp/vendor/` | MIT 授权的 bzip2 解码器及许可 |
| `src/bgp-download.mjs` | 无存储的原始文件转发 |
| `tests/bgp/` / `tests/worker/` | 合成解析、查询与转发测试 |

`.github/workflows/bgp-daily.yml`、SQLite 构建/发布脚本、R2 查询/上传 Worker、D1/Drizzle 模板和依赖已移除。CI 只保留代码检查与构建。旧查询/上传入口返回 410。

## 部署

沿用根目录 `wrangler.jsonc` 的单个 `bgp` Worker 和 `bgp.thanejoss.com` 域名：

```sh
pnpm exec wrangler deploy --dry-run
pnpm run deploy
```

无需 D1、R2 binding、`INGEST_TOKEN`、`R2_PUBLISH_TOKEN` 或数据发布 Variables。详见 [Cloudflare 部署说明](docs/cloudflare-deployment.md)。仓库改动不会自动删除旧云资源或 Secrets。

## 数据来源与署名

- [RouteViews HKIX archive](https://archive.routeviews.org/hkix.hkg/bgpdata/)
- [RouteViews 数据条款](https://www.routeviews.org/routeviews/licenses/)
- [CAIDA AS Relationships](https://www.caida.org/catalog/datasets/as-relationships/)
- [CAIDA AS-to-Organization](https://www.caida.org/catalog/datasets/as-organizations/)
- 界面参考：[thanejoss/webapps](https://github.com/thanejoss/webapps)

各数据集遵循原来源条款。AS 关系属于推断连接，不表示物理链路或带宽。
