# 依赖审查（2026-11-06）

## 当前结论

PR #4 的整合修复仍不能合并，但阻塞原因已经变化。[braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 于 **2026-10-23 撤回**，官方说明其不具备实际可利用性。不能继续把 10 月 22 日的“braces 无补丁”作为当前唯一阻塞，也不能仅凭撤回公告宣称完整审计通过。

2026-11-06 对原整合 head `dac85d1c6e4f1d788de087b1115740bb9286063f` 重跑 [PR CI attempt 2](https://github.com/ThaneJoss/bgp/actions/runs/39756972917/attempts/2)。[Auto / Quality 日志](https://github.com/ThaneJoss/bgp/actions/runs/39756972917/job/127998245308) 确认冻结安装、lint、typecheck、**20/20 测试**、构建和 **32 个 JS 语法检查**通过；随后 `pnpm audit --audit-level=high` 退出 1，报告 **17 项：2 critical、6 high、7 moderate、2 low**，Auto / Quality 与 Gate 保持失败。执行环境为 Node 22.23.2 / pnpm 11.25.0，通用 CI 仍固定于 `89624ba02d911171a634ddeb4848c298f3b1c842`。

这是完整依赖树在 high 阈值下的审计结果；日志展开了 8 条 high/critical 公告，未逐项展开另外 9 条较低级别告警。本轮没有取得新的 `pnpm audit --json` 报告，不将这些汇总数量表述成独立漏洞利用证明。

| 包 | 当前 high/critical 告警 | 公告列出的最低修补版本 |
| --- | --- | --- |
| Next 16.3.8 | [SVG Image Optimization RCE](https://github.com/advisories/GHSA-2464-fhr4-w9xw)、[use cache typed-array RCE](https://github.com/advisories/GHSA-673q-mjm6-r5xr)、[App Router Server Actions DoS](https://github.com/advisories/GHSA-p3m5-59mp-jv5r) | 16.4.1 |
| Zod | [受限集合验证时的内存耗尽](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)；日志包含根依赖、hookform resolver 和 ESLint 插件路径 | 4.6.6 |
| Undici 7.x | [content-encodings DoS](https://github.com/advisories/GHSA-xjj6-f33q-929c)、[跨域重定向缓存污染/信息泄漏](https://github.com/advisories/GHSA-4w7w-5xrc-9h26)、[TLS 选项丢失](https://github.com/advisories/GHSA-2m5v-pch6-74hx)、[TLS 1.2 renegotiation DoS](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm)；来自 Cloudflare/Miniflare 工具链 | 7.30.1 |

上述版本是审计公告中的修补下限，**不是已经安装或验收的版本**。应用由 Vinext 构建；审计中的 Next RCE 标签不证明本应用部署暴露了对应 Next 功能。SVG 公告列出的 sharp >=0.35.5 缓解条件已出现在当前锁文件中；另两条 Next 公告分别要求特定的 use-cache 返回值或 Server Action 入口。仍需分别验证实际入口、依赖兼容性和完整审计，不能把这些范围说明当作门禁豁免。

## 后续修复与验证边界

- 在可用执行环境中使用仓库固定的 pnpm 11.25.0 更新依赖和锁文件，复核 Next/ESLint/React 的 peer 范围；Zod 跨主版本需检查全部使用方与传递依赖，尤其当前 eslint-plugin-react-hooks 仍锁定 Zod 3.25.76，单改根依赖不足以清除全部路径；Undici 使用兼容的父依赖升级或限定范围的 override。
- 保留 `minimumReleaseAge: 10080`、缺失发布时间拒绝策略、`trustLockfile: false` 和安装脚本策略。候选版本必须满足现有安装策略，不加入 audit ignore、不降低 high 门槛，也不手工猜改锁文件的依赖闭包。
- 更新后重新运行冻结安装、peer 检查、lint、typecheck、全部标准测试、构建、完整 JSON 审计及 high 门禁；并按既有手动验收流程检查 Worker 产物、生命周期与桌面/移动端浏览器回归。通用 CI 不执行这些手动项目。
- 本轮云环境启动失败，无法运行包管理器生成新锁文件或补做浏览器/Worker 手动测试。因此仅完成远端标准 CI 重验与证据更新，**未实施上述新增依赖修补**；生产配置、应用代码、package/lock、测试源码和通用 CI 均保持原样。
- 继续复用草稿 PR #4；#6 与 #5 各自的旧 head 没有收到 #4 的修补，不能将整合分支的功能测试结果当成它们已通过。依赖顺序仍为 **#4 → #6 → #5 → main**，每一步都须检查其最终 head。本轮不合并、启用自动合并或手动部署。

## 历史记录：2026-10-22

以下保留当时的版本修补和验证记录；其中“当前”“剩余”等描述只适用于 2026-10-22，不代表上面的最新审计结论。

整合 PR #4、#5、#6 后，完整 `pnpm audit --json` 仍退出 1：**1 high（braces 3.0.3），0 critical / moderate / low**。因此不能合并，也不能把功能检查通过称为依赖审计通过。

### 已完成的修补

保留 PR #4 已验证的 Next / eslint-config-next 16.3.8、React / React DOM / react-server-dom-webpack 19.2.8、Cloudflare Vite 插件 1.42.1、Wrangler 4.103.0、Miniflare 4.20260617.1，以及 sharp、undici、brace-expansion、browserslist、source-map-js、baseline-browser-mapping、fast-uri、Babel 和 esbuild 的修补。保留 PR #6 的纯 Node 数据工具及固定开发依赖。

2026-10-22 对 PR #4 原 head `d2268178757d6d3df19127020a3422251660f7fd` 的完整锁文件重新查询官方 npm bulk audit，发现 6 条告警：braces 1 high，Vite 新增 1 high / 3 moderate / 1 low。继续采用已发布且满足七天期限的最小兼容版本：

| 依赖 | 更新 | 原因 |
| --- | --- | --- |
| Vite | 8.0.16 → 8.1.6（2026-10-06 发布） | 修复新增的文件访问等漏洞，包括 [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm) |
| Vinext | 1.0.0-beta.5 → 1.0.1（2026-10-01 发布） | 固定引入 `@vercel/og 1.0.3`，其 Node/Edge bundle 内嵌修补后的 Satori 0.33.5，并支持新增的 HarfBuzz WASM |
| `@vitejs/plugin-rsc` | 0.5.26 → 0.5.34（2026-08-07 发布） | 满足 Vinext 1.0.1 的 peer 范围 |
| `satori@0.33.5 > fflate` | 0.7.3 → 0.7.5 | 修补新闭包的 [ZIP64 溢出漏洞](https://github.com/advisories/GHSA-px8p-9vwx-vf98)；旧 `fflate@0.7.4` 覆盖仍保留 |
| `vinext > image-size` | 限定父版本更新为 1.0.1，仍固定 2.0.4 | 保留原安全修补 |

包版本和发布时间核对自 [官方 npm registry](https://registry.npmjs.org/)。Satori 的 [SVG 转义公告](https://github.com/vercel/satori/security/advisories/GHSA-wx4j-mvgx-mqwp) 不在此前 pnpm audit 结果中；这次更新的是内嵌它的 OG bundle，不能仅覆盖安装树中的 satori 版本。应用没有动态 OG 路由，仍需明确区分依赖包修补、渲染验证和当前功能入口。

保留 `.node-version` 22.23.2、pnpm 11.25.0、`minimumReleaseAge: 10080`、缺失发布时间拒绝策略、`trustLockfile: false`、安装脚本白名单。没有加入审计 ignore、别名替换、降低阈值或修改网络/生产配置。

### 剩余合并阻碍

[braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 的深层嵌套模式可导致栈耗尽。2026-10-22 官方公告仍标注无补丁，npm 最新仍是 3.0.3，不能将未发布的 3.0.4 当成修复。两条路径为：

- `eslint-config-next@16.3.8 > @next/eslint-plugin-next@16.3.8 > fast-glob@3.3.1 > micromatch@4.0.8 > braces@3.0.3`。
- `vinext@1.0.1 > vite-plugin-commonjs@0.10.4 > vite-plugin-dynamic-import@1.6.0 > fast-glob@3.3.3 > micromatch@4.0.8 > braces@3.0.3`。

截至复核，最新 Next ESLint 16.4.2、Vinext 1.3.0 和各 glob 父包仍保留此链。fast-glob [#535](https://github.com/mrmlnc/fast-glob/pull/535) 已关闭未合并、[#536](https://github.com/mrmlnc/fast-glob/pull/536) 尚未发布。其他 brace/glob 包不提供相同导出及同步解析语义；本轮没有用不兼容别名或自造版本规避告警。

当前 `next.config.ts` 为空，也未配置 Next ESLint `settings.next.rootDir`，未发现网页输入进入上述 glob 路径；这不等于漏洞已修补，完整 high 阈值仍失败。通用 CI 的强制审计继续阻断合并。

### 验证边界

复核命令为 `pnpm install --frozen-lockfile`、`pnpm peers check`、`pnpm audit --json` 和 `pnpm audit --audit-level=high`。功能检查包括 lint、typecheck、20 项标准测试、生命周期/路径图、生产构建、生产浏览器 Worker 及桌面/移动 Chromium；每项是否执行与结果以 PR 的最终 head 报告为准。

Vinext 1.0.1 将浏览器 Worker 放入 `_next/static/workers/`；产物验证改为递归查找且要求恰好一个 Worker，仍执行合成解压、查询和错误路径。浏览器回归增加 ASN 深链接的手动加载与请求完成前返回全球视图，确保迟到响应不能覆盖用户操作。

本仓库只保留固定 SHA 的通用 workflow，未恢复旧独立审计或 UI 工作流。通用 CI 强制审计包括开发依赖；生命周期、Worker 和浏览器检查源码保留为手动验证。历史 61 条基线归因保留于 [2026-10-13 记录](bgp/dependency-attribution.md)，不是当前整合后的审计结果。没有手动部署、修改凭据或生产资源。
