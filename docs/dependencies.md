# 依赖审查（2026-10-13）

本次审查以 `64ad2bd8c3e0768876f8938b55ad95a89587a8d4` 为基线。原锁文件的 `pnpm audit --json` 报告 61 项告警：1 critical、30 high、22 moderate、8 low；原依赖审计未通过。

首次修补后仍有 6 项告警。本轮进一步核对官方公告和实际发布版本，修复其中 5 项；最新锁文件的审计剩余 **1 项 high：braces 3.0.3**（0 critical、0 moderate、0 low）。`pnpm audit --json` 仍实际退出 **1**；依赖审计未通过，不能将构建和测试通过等同于依赖告警清零。

## 本次更新范围

保留现有框架与 Cloudflare 构建链，仅更新有明确修复版本的依赖。本次更新的直接依赖使用精确版本；传递依赖通过锁文件刷新和限定父包或旧版本的 `pnpm-workspace.yaml` overrides 更新。

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

本轮在原修补基础上完成以下兼容更新：

| 告警及实际依赖路径 | 修补版本 | 官方依据 |
| --- | --- | --- |
| `vinext > @vercel/og > satori > @shuding/opentype.js > fflate` | 0.7.4 → 0.7.5 | [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98) 的 0.7 系列修复；修补已安装的包，OG 内嵌代码仅保留字体解压 `inflateSync`，未包含此公告的 ZIP64 / `unzipSync` 路径 |
| `next > baseline-browser-mapping`（含 vinext 间接引入的 Next） | 2.10.30 → 2.11.27 | [GHSA-w5vr-8v7q-w6rv](https://github.com/advisories/GHSA-w5vr-8v7q-w6rv)，修复从 2.11.0 起 |
| `@hookform/resolvers / webpack > … > ajv > fast-uri` | 3.1.7 → 3.1.8 | [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) 的 3.x 修复 |
| `next > styled-jsx > @babel/core`、`eslint-config-next > eslint-plugin-react-hooks > @babel/core` | 7.29.0 → 7.29.6 | [GHSA-4x5r-pxfx-6jf8](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8)；采用官方 7.29.6，未采信 audit 响应中较早的修复下界 |
| Vite / tsx / Wrangler 引入的 esbuild | 0.27.3 / 0.28.0 → 0.28.1 | [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) 的 Windows 开发服务器路径遍历修复 |

为使用 esbuild 0.28.1，将 Wrangler 更新至 **4.103.0**、Cloudflare Vite 插件至 **1.42.1**，匹配 Miniflare **4.20260617.1** 与 workers-types **4.20260617.1**。这组版本于 2026-06-17 至 06-19 发布，继续使用 Miniflare 4，满足当前 Node 22 和 Vite 8 要求；没有将 Wrangler 固定的 esbuild 0.27 强制覆盖为 0.28。保留 scoped undici / sharp 修补，移除上游已包含 ws 8.21.0 的过时覆盖；`pnpm peers check` 无问题。参见 [Wrangler 发布说明](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.103.0) 与 [Vite 插件发布说明](https://github.com/cloudflare/workers-sdk/releases/tag/%40cloudflare%2Fvite-plugin%401.42.1)。生产配置、兼容日期和域名保持不变。

## 尚未解决的范围

`braces 3.0.3` 的深层嵌套模式可导致栈耗尽：[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)。截至本次核对，官方公告标注没有修复版本，npm registry 也未发布 3.0.4；不能将 audit 响应中的 `>=3.0.4` 当成可安装的修复。

锁文件中的两条路径及当前入口如下：

- `eslint-config-next@16.3.8 > @next/eslint-plugin-next@16.3.8 > fast-glob@3.3.1 > micromatch@4.0.8 > braces@3.0.3`：Next ESLint 在配置 `settings.next.rootDir` 时调用此 glob 分支；本项目未配置该项，默认使用当前目录。
- `vinext@1.0.0-beta.5 > vite-plugin-commonjs@0.10.4 > vite-plugin-dynamic-import@1.6.0 > fast-glob@3.3.3 > micromatch@4.0.8 > braces@3.0.3`：用于加载 Next 配置源码时的动态导入解析；当前 `next.config.ts` 为空配置对象。

未发现网页请求、目标 IP 或 MRT 字节进入这些 glob 入口，但开发和构建依赖中的 high 仍未修复。最新已发布的 Next ESLint、Vinext、CommonJS 插件和 fast-glob 父依赖仍保留此路径；fast-glob 的替换提案 [#535](https://github.com/mrmlnc/fast-glob/pull/535)、[#536](https://github.com/mrmlnc/fast-glob/pull/536) 尚未合并发布。直接 alias 到 brace-expansion 会改变导出、默认编译、转义及去重语义；tinyglobby 也不提供调用方使用的 `.sync` API，不能充当无修改替换。当前未找到已发布、兼容的直接修复路线，后续应评估上游发布或带兼容验证的补丁；没有伪造修复版本、忽略告警或修改安全策略。

本次同时核对了严重告警的使用范围：应用没有 `next/og`、`ImageResponse` 或动态 OG 路由，也没有配置 `images.remotePatterns`，未发现对应 Next 图像漏洞的当前应用触发入口。应用没有声明 Server Functions；开发服务器仍包含框架的 RSC 处理路径，因此仍同步升级 React 三个包，不能仅凭应用未声明函数跳过修复。参见 [Next 图像 RCE 公告](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j)、[Next 图像 SSRF 公告](https://github.com/advisories/GHSA-cjq9-62q9-8jv4) 和 [RSC 公告](https://github.com/advisories/GHSA-wx67-qw84-cm4g)。

审计数据库并非完整清单：vinext 的未使用 OG 功能仍引入 `satori 0.16.0`，落在 [Satori SVG 转义公告](https://github.com/vercel/satori/security/advisories/GHSA-wx4j-mvgx-mqwp) 的受影响范围，却未出现在本次 pnpm audit 响应中。`@vercel/og 0.8.6` 的 Node 与 Edge 产物直接内嵌该代码，单独覆盖传递 satori 版本不会修复它。已确认 `@vercel/og 1.0.3` 内嵌修复后的 satori 0.33.5；但新版本增加 HarfBuzz `hb.wasm`，当前 Vinext beta 的资产插件未处理它，不能安全地只覆盖 OG 父包。Vinext 1.0.1 提供相应适配；实施这条额外框架升级路线需同时验证 Node 和 Worker 的 OG 渲染。

当前应用没有 OG 生成入口。本轮没有扩大到这条未使用功能的框架升级，因此该已知限制仍保留；不能把审计仅剩 1 high 写成所有已知漏洞只剩一项。未来启用 OG 前须完成上述整条依赖链更新和渲染验证。其 WASM 渲染链不能直接等同于 Next 公告描述的 Node RCE 链。

## 复核方法

```sh
pnpm install --frozen-lockfile
pnpm audit --json
pnpm audit --audit-level=low
pnpm audit --audit-level=high
```

新增独立 `Dependency audit` PR 工作流，直接执行完整锁文件的 `pnpm audit --audit-level=low`，保留失败退出码，没有忽略项或 `continue-on-error`。因此当前 braces 会明确使审计检查失败，普通代码 CI 成功不能抵消它；未修改分支保护。其他 PR 检查覆盖 lint、类型、合成数据、生产构建和本地浏览器行为，详见 [CI 说明](bgp/ci.md)。本轮没有手动部署或修改生产资源、凭据；仓库原有 Cloudflare GitHub 集成会在分支 push 后自动生成预览，其平台状态需单独核对。
