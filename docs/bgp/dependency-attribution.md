# Node 迁移的依赖审计归因

2026-10-13 核对结果：本次新增依赖没有已报告告警；30 high / 1 critical 均已存在于 main / PR #5 基线。**整个项目的审计和 CI gate 仍失败，不能据此称为完整安全验收。** 本轮只补充归因证据，不把既有框架、Cloudflare 和 ESLint 链升级混入数据工具迁移。

## 可复核证据

比较 main `64ad2bd8c3e0768876f8938b55ad95a89587a8d4`、PR #5 `1974d667aeb4f086da45528c12b859df895f1ddc` 和迁移实现 `a57de50b1811fa363853a15ac42ed5d3936c5704`。main / #5 的锁文件逐字节相同；原 775 个 packages 与 775 个 snapshots 块，包括 integrity、版本和传递依赖，迁移后均逐字节不变，40 个既有根依赖版本也未变化。只增加 12 个开发依赖锁节点。

| 只读完整 registry 审计 | main / #5 | 迁移 |
| --- | --- | --- |
| low / moderate / high / critical | 8 / 22 / 30 / 1 | 8 / 22 / 30 / 1 |
| advisory entries / 唯一 GHSA | 61 / 55 | 61 / 55 |
| 完整 advisory 对象（含所有版本和路径） | 与迁移完全相同 | 与基线完全相同 |
| 本次新增 advisory | — | 0 |
| 锁节点数 | 775 | 787 |

完整审计的 894 条 finding paths 均可在 main 锁中沿根依赖与 snapshots 的依赖边解析；这些路径的节点在 #5 / 迁移中未改变。`--audit-level=high` 的 CI 只显示 31 个 high/critical 表块，不代表审计只有 31 项；完整 JSON 同时包含 low/moderate。机器可读摘要及每项告警的版本、路径数量和示例见 [dependency-attribution.json](dependency-attribution.json)。

原实现 head 的 [PR CI](https://github.com/ThaneJoss/bgp/actions/runs/38358019905) / [push CI](https://github.com/ThaneJoss/bgp/actions/runs/38357940511) 均已实际通过冻结安装、lint（1 个既有 warning）、类型、20/20 测试、构建和 JS 语法，在 `pnpm audit --audit-level=high` 退出 1。后续精确 head 的结果以 PR 描述及 Actions 为准，不能把父提交的通过当成新 head 的结果。

归因另用只读 `pnpm audit --json` 在迁移目录及只含 main 原始 package/lock/workspace 的临时目录查询官方 registry，不安装依赖、不运行功能测试、不下载外部数据。两份完整 advisory 对象深度相等。功能测试仍仅在 GitHub CI 运行；没有新增专属 CI、改变模板或降低阈值。

## 新增闭包及替代评估

- Graphology 0.26.0 → 既有 events 3.3.0；Louvain 2.0.2 → graphology-indices 0.17.0、graphology-utils 2.5.2、mnemonist 0.39.8、pandemonium 2.4.1；mnemonist → obliterator 2.0.5；peer 为 graphology-types 0.24.8。
- compressjs 1.0.3 → amdefine 1.0.1、commander 2.8.1 → graceful-readlink 1.0.1。

上述闭包没有连向任何告警包。对这 12 个新节点及共用 events 3.3.0，官方 npm bulk security 接口也成功返回 `{}`。这表示查询当时没有收录的匹配告警，不是未来漏洞或完整代码安全保证。

[Graphology / Louvain](https://github.com/graphology/graphology) 的固定版本均为查询当时最新发布版、MIT，保持原选择。[compressjs](https://github.com/cscott/compressjs#license-gplv2) 发布较早、GPL-2.0-or-later，当前仅用于测试编码；已有独立浏览器解码器的多块、拼接、CRC 和固定小样本测试通过，没有审计问题要求替换它。候选检查如下，未安装或改用这些包：

| 编码替代 | 当前判断 |
| --- | --- |
| [bzip2-codec 2.0.1](https://github.com/osztenkurden/bzip2-codec#work-with-small-values) | 同步编码、零依赖、Node 版本要求可满足；仍为 GPL-3.0，发布历史短。没有证据证明本任务中更安全或更兼容。 |
| [Digital-Defiance bzip2-wasm](https://github.com/Digital-Defiance/bzip2-wasm/blob/master/index.js) | wrapper 仍修改全局 require / __dirname；长度指针分配与默认输出容量问题未改正，不因重发或增加类型就替换。 |
| [node-bzip2](https://github.com/WilliamVenner/node-bzip2/blob/master/package.json) | 原生 node-gyp 构建会重新引入 [Python 构建要求](https://github.com/nodejs/node-gyp#on-unix)，不满足本次目标。 |
| [Foxglove wasm-bz2](https://github.com/foxglove/wasm-bz2) | 仅解压，不能生成测试编码样本。 |

## 既有告警的修复范围

以下为本次报告中全部 high/critical 涉及的包。补丁目标已核对官方 registry 确实发布，并满足本次已知 advisory 的补丁范围；尚未安装或验证其框架、Worker 和浏览器功能，不能称为已验收的安全替代。

| 基线包 | 本次已发布补丁目标 / 限制 | 涉及范围 |
| --- | --- | --- |
| Next 16.3.4 | 16.3.8 覆盖报告中的 critical next/og RCE 与 high Image Optimization SSRF | Next / Vinext 框架和构建产物，需协调 PR #4 |
| react-server-dom-webpack 19.2.6 | 19.2.8；其 peers 要求 react / react-dom ^19.2.8，现有 19.2.6 不满足 | React/RSC 三件套及全部 RSC peer contexts，不能单包替换 |
| Vite 8.0.13 | 8.0.16 | Cloudflare、React、RSC、Vinext 插件及生产构建 |
| undici 7.24.8 / ws 8.18.0 | 7.29.1 / 8.21.0 | Cloudflare 插件、Wrangler、Miniflare 的网络与本地 Worker 链 |
| sharp 0.35.4 | 0.35.5；当前 miniflare>sharp override 强制 0.35.4，须同步审查覆盖策略 | Next 图片处理、Miniflare 平台二进制与安装策略 |
| brace-expansion 1.1.14 / 5.0.6 | 1.1.20 / 5.0.11，各自原 major 内的补丁 | ESLint / minimatch / TypeScript 解析传递链 |
| js-yaml 4.1.1 | 4.3.2 | ESLint / ESLint Next 链 |
| source-map-js 1.2.1 | 1.2.2 | Next、Vite、Tailwind / PostCSS 传递链 |
| browserslist 4.28.2 | 4.28.7 | Next Babel、Webpack / RSC 构建目标 |
| image-size 2.0.2 | 2.0.3 | Vinext 图片工具链 |
| braces 3.0.3 | 没有已发布修复；advisory JSON 的 >=3.0.4 不是可安装版本 | eslint-config-next → fast-glob → micromatch，以及 vinext → commonjs/dynamic-import → fast-glob → micromatch；须审查父依赖/替代方案 |

完整 17 个告警包还包括低/中级别的 @babel/core、baseline-browser-mapping、esbuild、fast-uri、fflate；它们同样全部来自基线。此轮没有审计忽略、吞错、降低阈值或广泛升级。上述修复需作为现有依赖工作协调 PR #4，重新验证最终 head，不能因本次迁移没有新增告警就接受仍失败的项目 gate。
