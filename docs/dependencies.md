# 依赖审查（2026-10-13）

本次审查以 `64ad2bd8c3e0768876f8938b55ad95a89587a8d4` 为基线。原锁文件的 `pnpm audit --json` 报告 61 项告警：1 critical、30 high、22 moderate、8 low；原依赖审计未通过。

更新锁文件后再次审计，剩余 **6 项：0 critical、1 high、3 moderate、2 low**。`pnpm audit --json` 和 `pnpm audit --audit-level=high` 均实际退出 **1**，因此本次依赖审计仍未通过；不能将构建和测试通过等同于依赖告警清零。

## 本次更新范围

保留现有框架与 Cloudflare 构建链，仅更新有明确修复版本的依赖。直接依赖使用精确版本；传递依赖通过锁文件刷新和限定父包或旧版本的 `pnpm-workspace.yaml` overrides 更新。

| 依赖 | 更新后版本 | npm 发布时间（UTC） |
| --- | --- | --- |
| Next / eslint-config-next | 16.3.8 | 2026-09-30 |
| React / React DOM / react-server-dom-webpack | 19.2.8 | 2026-07-21 |
| Vite | 8.0.16 | 2026-06-01 |
| sharp | 0.35.5 | 2026-09-27 |
| Miniflare 使用的 undici | 7.29.1 | 2026-09-04 |
| Miniflare / Cloudflare Vite 插件使用的 ws | 8.21.0 | 2026-05-22 |
| vinext 使用的 image-size | 2.0.4 | 2026-09-14 |

此外定向刷新 brace-expansion、js-yaml、browserslist 和 source-map-js 的兼容版本。Next 与 Miniflare 的 sharp 来源均覆盖，避免只修复其中一条依赖路径。React 三个包同步更新，以满足 RSC 的 peer 版本要求。

发布时间和版本要求核对自 [npm registry](https://registry.npmjs.org/)。上述版本均已发布超过一周，兼容仓库固定的 Node 22.23.2。`minimumReleaseAge: 10080`、缺失发布时间拒绝策略、锁文件信任规则和安装脚本白名单保持不变；未新增审计忽略项。

继续使用 Wrangler 4.92.0、Cloudflare Vite 插件 1.37.1 和 Miniflare 4 系列。本次不通过升级整套 Cloudflare 工具链引入 Miniflare 5 alpha；限定到现有父包版本的 overrides 用于修复传递依赖，后续升级父包时需重新评估并移除过时覆盖。

## 尚未解决的范围

`braces 3.0.3` 的深层嵌套模式可导致栈耗尽：[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)。截至本次核对，官方公告标注没有修复版本，npm registry 也未发布 3.0.4；不能将 audit 响应中的 `>=3.0.4` 当成可安装的修复。

本仓库通过 ESLint 与 Vite 动态导入构建插件间接使用 braces。未找到将网页请求、目标 IP 或 MRT 字节传给这些 glob 模式处理入口的应用代码，但开发和构建工具链仍保留告警。没有忽略它，也没有为消除告警替换构建架构。应在上游发布修复后重新评估。

其余告警为 fflate、baseline-browser-mapping、fast-uri 的 moderate，以及 esbuild、@babel/core 的 low。本次没有为清空这些剩余告警继续扩大框架或工具链升级范围。

本次同时核对了严重告警的使用范围：应用没有 `next/og`、`ImageResponse` 或动态 OG 路由，也没有配置 `images.remotePatterns`，未发现对应 Next 图像漏洞的当前应用触发入口。应用没有声明 Server Functions；开发服务器仍包含框架的 RSC 处理路径，因此仍同步升级 React 三个包，不能仅凭应用未声明函数跳过修复。参见 [Next 图像 RCE 公告](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j)、[Next 图像 SSRF 公告](https://github.com/advisories/GHSA-cjq9-62q9-8jv4) 和 [RSC 公告](https://github.com/advisories/GHSA-wx67-qw84-cm4g)。

审计数据库并非完整清单：vinext 的未使用 OG 功能仍间接依赖 `satori 0.16.0`，落在 [Satori SVG 转义公告](https://github.com/vercel/satori/security/advisories/GHSA-wx4j-mvgx-mqwp) 的受影响范围，却未出现在本次 pnpm audit 响应中。当前应用没有 OG 生成入口；未来启用这项功能前，应重新审查并更新整条图像渲染依赖链。其 WASM 渲染链不能直接等同于 Next 公告描述的 Node RCE 链。

## 复核方法

```sh
pnpm install --frozen-lockfile
pnpm audit --json
pnpm audit --audit-level=high
```

依赖告警不会因本次代码检查通过而自动消失。审计需独立报告实际退出状态；PR CI 验证锁定依赖的 lint、类型、合成数据测试、生产构建和本地浏览器行为，详见 [CI 说明](bgp/ci.md)。本次未部署，也未修改生产资源或凭据。
