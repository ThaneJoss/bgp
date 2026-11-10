# 依赖审查

## 当前结论：2026-11-10，#6 / #5 仍待到龄安全补丁

PR #4 已以 `3ab7889d1117a755e81052df013914546b085f21` 合入 #6 分支。#6 随后同步 main `36c1f502d8841c3c434fb6f90cfd2ee4aa97f636` 的普通 Worker Route / 现有 CNAME 修复，避免后续合并恢复同名 Custom Domain；README 中误留的 Python 压缩样本要求也已修正。本轮没有修改 package、锁文件、七天安装策略或固定 SHA 的通用 CI。

**#6 / #5 继续保持 draft，不合并、不启用自动合并。** 2026-11-10 实际完整 `pnpm audit --json` 仍只返回 minimatch 的 1 moderate，high 门槛退出 0；这不能覆盖未进入 npm 审计数据库的官方公告。重新读取 [Undici GHSA-mqg3-3v4r-cm32](https://github.com/nodejs/undici/security/advisories/GHSA-mqg3-3v4r-cm32) 确认其仍为 High，当前 7.30.1 在受影响范围内，修补版为 7.30.2。重新读取 [Next GHSA-mfr8-8qww-v76h](https://github.com/vercel/next.js/security/advisories/GHSA-mfr8-8qww-v76h) 也确认当前 16.4.3 仍在受影响范围内，需至少 16.4.5。

本轮重新查询官方 npm registry 的发布时间，按 10080 分钟计算：

| 候选 | 发布时间（UTC） | 最早可安装（UTC） |
| --- | --- | --- |
| Next 16.4.5 | 2026-11-03 18:01:54.667 | **2026-11-10 18:01:54.667** |
| eslint-config-next 16.4.5 | 2026-11-03 17:52:34.911 | 2026-11-10 17:52:34.911 |
| Undici 7.30.2 | 2026-11-05 09:06:58.994 | **2026-11-12 09:06:58.994** |

核对时尚未到龄，未尝试安装这些候选、手工改锁或添加策略例外。Next 的配套平台包也须逐一满足期限。到龄后先重新核对全部最新公告、发布时间、兼容范围和父包声明，再用固定 pnpm 生成锁文件；日期到达本身不代表通过安全验收。minimatch 仍保留上游兼容性阻碍，不强制跨主版本覆盖。

### 本轮云端验证（Linux，Node 22.23.2 / pnpm 11.25.0）

对合入 main 路由修复后的代码执行：

- 冻结安装、peer 检查、lint、typecheck、20/20 标准测试（0 skip / fail）、构建、生产 Worker 产物检查和所有跟踪 JS 文件语法检查通过。
- `pnpm test:functional` 的生命周期与路径图脚本均通过。Windows 历史超时未在本次 Linux 重现；没有修改或放宽脚本，也没有重测 Windows，不能写成 Windows 已修复。
- Wrangler `deploy --dry-run` 通过；源配置与生成的 `dist/server/wrangler.json` 均保留 `bgp.thanejoss.com/*`、`zone_name: thanejoss.com`，没有 Custom Domain。没有手动部署或 DNS 变更。
- Chromium 验收**未完成**：锁定 Playwright Chromium 下载返回无效 ZIP；使用既有系统 Chromium 156.0.8078.79 的临时本地配置后，六项用例均在浏览器启动阶段因 `socket() failed: Operation not permitted` 失败，尚未执行页面断言。允许执行的重试仍同样失败。仓库 Playwright 配置、测试和断言均未改动；不能把启动失败计为页面回归通过。
- 完整审计退出 1（1 moderate），high 门槛退出 0；官方 Undici High 仍阻止下游合并。

剩余顺序为 **#6 → #5 → main**。#5 仍为旧 head `1974d667aeb4f086da45528c12b859df895f1ddc`，未获得这些修复；每个 PR 都必须在自己的最终 head 重新验证 CI，不能借用上游的绿灯。通用 CI 不包含手动浏览器检查。

## 历史记录：2026-11-06 本轮部分修补，仍不可合并

本轮在 PR #4 head `30e9c887618a4a08a182cc7d84b2abe83d3130ce` 的基础上更新依赖及由 pnpm 生成的锁文件。使用官方 npm registry 重现修补前完整审计 **17 项：2 critical、6 high、7 moderate、2 low**；候选锁的完整 JSON 审计变为 **1 moderate、0 critical / high / low**，剩余项为 minimatch。[机器可读审计摘要](dependency-audit-2026-11-06.json) 包含前后锁文件 SHA-256、公告及版本，审计包含开发依赖。

**这不代表全部已知安全问题已修复，也不构成合并许可。** 人工核对发现，Next 2026-11-03 和 Undici 2026-11-05 的官方仓库公告仍覆盖候选版本，其中 Undici 有一项明确标为 High。对官方 npm bulk advisory 服务单独查询候选 Next / Undici 版本时，这批新公告尚未返回；机器审计可能晚于维护者公告。PR #4 继续保持草稿，后续必须完成到龄补丁和最终 head 验证。

### 已实施的候选升级

| 依赖 | 本轮候选 | 选择依据与兼容范围 |
| --- | --- | --- |
| Next / eslint-config-next | 16.3.8 → **16.4.3** | 已满足七天期限，覆盖此前 16.4.1 修复的 RCE / DoS 公告；Next、ESLint 配置及 Next 平台包保持同版。仍有下表列出的七项新公告。 |
| React / React DOM / react-server-dom-webpack | 19.2.8 → **19.2.9** | [React RSC RCE](https://github.com/react/react/security/advisories/GHSA-xqc2-xf4c-x3h3) 与 [Server Functions DoS](https://github.com/react/react/security/advisories/GHSA-h3gv-c5rc-p453) 的同系列补丁。RSC 的 React / DOM peer 均为 `^19.2.9`；Vinext 1.0.1 的 `^19.2.6` 和 RSC 插件 0.5.34 的 peer 范围允许本次升级。 |
| Zod | 3.25.76 → **4.6.7** | 覆盖 [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) 的 4.6.6 修补下限。根依赖固定版本，并限定 `eslint-plugin-react-hooks@7.1.1 > zod` 为同版，锁中不再保留 Zod 3。 |
| Undici（Miniflare 路径） | 7.29.1 → **7.30.1** | 保留 `miniflare@4.20260617.1 > undici` 的限定 override；修补 TLS 校验选项丢失、TLS renegotiation 崩溃及 content-encoding 错误等独立问题。缓存修补仍不完整，**不是全部已知漏洞的最终修复版**。 |
| fast-uri | 3.1.8 → **3.1.9** | [官方 3.1.9 安全发布](https://github.com/fastify/fast-uri/releases/tag/v3.1.9) 修补四项 URI 解析 / 规范化公告；Ajv 8.20.0 的 `^3.0.1` 范围允许该补丁。保留对旧 3.1.7 路径的修补并覆盖实际 3.1.8 路径。 |

Zod 4 升级在使用方声明范围内：`@hookform/resolvers@5.7.1`、`eslint-plugin-react-hooks@7.1.1` 和保留的 `zod-validation-error@4.0.2` 均接受 `^3.25.0 || ^4.0.0`。已核对 Hooks 7.1.1 发布包实际引用 `zod/v4` 与 `zod-validation-error/v4`；应用源码未发现直接 Zod / resolver 导入。这里没有把只支持 Zod 3 的依赖强行覆盖成 Zod 4，仍须用 lint、类型检查和既有功能验证确认新闭包。

锁文件的新增包版本均来自上表及 Next 的配套平台包；React peer 标识同步更新。解析器另将四处依赖归并到原锁中已有版本：Hooks 的 Babel parser 7.29.9、Next 的 caniuse-lite 1.0.30001814、Webpack 的 es-module-lexer 2.3.2，以及可选 wasm-runtime 的 emnapi core 1.11.1 / wasm-util 0.10.4。未升级 ESLint、TypeScript、Vinext、Vite、Wrangler 或 Miniflare 主包。

### 人工核实的 Next 剩余公告

[Next 2026-11-03 官方安全发布](https://nextjs.org/blog/november-2026-security-release) 的七项修复均需 **16.4.5**；本轮 16.4.3 在以下全部范围内。仓库公告当前均标 Moderate，但官方博客将第一项标为 High，保留这一来源差异，不能据机器审计概括成“无高危风险”。

| 官方仓库公告 | Next 16.x 受影响范围 | 仓库当前严重性 |
| --- | --- | --- |
| [GHSA-mfr8-8qww-v76h](https://github.com/vercel/next.js/security/advisories/GHSA-mfr8-8qww-v76h) | `>=16.3.0 <=16.4.4` | Moderate；博客为 High |
| [GHSA-vc7v-qv4w-wrv8](https://github.com/vercel/next.js/security/advisories/GHSA-vc7v-qv4w-wrv8) | `>=16.2.0 <=16.4.4` | Moderate |
| [GHSA-vvgp-ww4w-46vf](https://github.com/vercel/next.js/security/advisories/GHSA-vvgp-ww4w-46vf) | `>=16.4.0 <=16.4.4` | Moderate |
| [GHSA-rhh4-g77r-r9qj](https://github.com/vercel/next.js/security/advisories/GHSA-rhh4-g77r-r9qj) | `>=16.0.0 <=16.4.4` | Moderate |
| [GHSA-pc58-hwjq-p385](https://github.com/vercel/next.js/security/advisories/GHSA-pc58-hwjq-p385) | `>=16.0.0 <=16.4.4` | Moderate |
| [GHSA-7qx7-33qx-rqx2](https://github.com/vercel/next.js/security/advisories/GHSA-7qx7-33qx-rqx2) | `>=16.0.0 <=16.4.4` | Moderate |
| [GHSA-f3mh-rxg3-f5g2](https://github.com/vercel/next.js/security/advisories/GHSA-f3mh-rxg3-f5g2) | `>=16.0.0 <=16.4.4` | Moderate |

### 人工核实的 Undici 剩余公告

[Undici 7.30.2 官方安全发布](https://github.com/nodejs/undici/releases/tag/v7.30.2) 修补六项新公告；本轮 7.30.1 仍全部受影响。

| 官方仓库公告 | Undici 7.x 受影响范围 | 严重性 |
| --- | --- | --- |
| [GHSA-mqg3-3v4r-cm32](https://github.com/nodejs/undici/security/advisories/GHSA-mqg3-3v4r-cm32) | `>=7.30.1 <7.30.2` | **High** |
| [GHSA-7xg3-fphp-28hg](https://github.com/nodejs/undici/security/advisories/GHSA-7xg3-fphp-28hg) | `>=7.0.0 <7.30.2` | Moderate |
| [GHSA-5rm8-gv32-r954](https://github.com/nodejs/undici/security/advisories/GHSA-5rm8-gv32-r954) | `>=7.0.0 <7.30.2` | Moderate |
| [GHSA-9v6h-8rgp-m69f](https://github.com/nodejs/undici/security/advisories/GHSA-9v6h-8rgp-m69f) | `>=7.0.0 <7.30.2` | Moderate |
| [GHSA-3g9m-rv3r-w5w2](https://github.com/nodejs/undici/security/advisories/GHSA-3g9m-rv3r-w5w2) | `>=7.0.0 <7.30.2` | Moderate |
| [GHSA-r4pc-4jcp-7pqc](https://github.com/nodejs/undici/security/advisories/GHSA-r4pc-4jcp-7pqc) | `>=7.15.0 <7.30.2` | Moderate |

第一项是此前 [GHSA-4w7w-5xrc-9h26](https://github.com/nodejs/undici/security/advisories/GHSA-4w7w-5xrc-9h26) 缓存修补不完整的绕过，不能从新公告的版本区间推断 7.29.1 原先没有同类风险。本轮保留 7.30.1 的理由是减少已确认的 TLS / DoS 等攻击面，而非用审计告警数量或颜色选择版本；**人工已知 High 继续阻止合并**。

该 High 要求同时使用无固定 origin 的 `Agent`、共享缓存及 `compose(redirect(), cache())`。对 Miniflare 4.20260617.1 发布包主入口的静态检查发现 `fetch`、`Pool`、`MockAgent` 和全局 dispatcher 调用，未发现该缓存 interceptor 组合。此检查仅限已检查源码，不能排除外部全局 dispatcher 配置，也不能证明整个部署不可利用，更不能作为豁免。应用构建使用 Vinext；Next 的包版本告警同样不能单独证明线上暴露了所有对应功能。

### 七天期限与 minimatch 阻塞

以下时间来自[官方 npm registry](https://registry.npmjs.org/)，按现有 `minimumReleaseAge: 10080` 分钟计算，均为 UTC：

| 待补齐版本 | 发布时间 | 最早满七天时间 |
| --- | --- | --- |
| Next 16.4.5（同时对齐 eslint-config-next 及平台包） | 2026-11-03 18:01:54.667 | **2026-11-10 18:01:54.667** |
| Undici 7.30.2（继续限定 Miniflare 父版本） | 2026-11-05 09:06:58.994 | **2026-11-12 09:06:58.994** |

本轮 Next 16.4.3、React 三件套 19.2.9、Zod 4.6.7、Undici 7.30.1、fast-uri 3.1.9 均已满七天。当前不存在已满七天且覆盖上述全部已知公告的 Next 16.x / Undici 7.x 候选；不通过 age exclusion、降低期限或接受缺失发布时间来绕过要求。

剩余机器告警 [minimatch GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) 为 Moderate，影响 `>=7.0.0 <11.0.1`，锁定路径为 `@typescript-eslint/typescript-estree@8.59.3 > minimatch@10.2.5`。当前父包及核对时最新稳定父包 8.72.1 均声明 `minimatch: ^10.2.2`，因此 Next ESLint 更新不会自动获得 11.x 修复。11.0.1 虽已满七天，仍超出父包声明范围；不通过全局跨主版本 override 或降级绕过公告，保留此项并等待上游支持的修补路径。

保留 `minimumReleaseAgeIgnoreMissingTime: false`、`trustLockfile: false`、`strictDepBuilds: true`、安装脚本白名单及 high 审计门槛；没有加入 audit ignore，也不把官方 npm 暂未收录的公告视为已关闭。到龄后必须重新查询公告与 peer 范围、生成锁文件，并完成冻结安装、完整 JSON 审计、high 门禁及项目既有验证；这些是后续操作要求，不表示已创建定时任务。

### 本轮本地验证（Windows，Node 22.23.2 / pnpm 11.25.0）

| 检查 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过；七天发布时间、缺失时间拒绝、锁文件验证及构建脚本策略保持原样 |
| `pnpm peers check`、lint、typecheck | 全部通过，peer 无问题 |
| `pnpm test` | **20/20 通过，0 skip / fail**；使用工作区内的临时目录 |
| `pnpm build` | 通过，生成生产 RSC / SSR / 浏览器资源 |
| `pnpm test:worker` | 通过；实际生产 Worker 下载、解压、导入、查询及错误路径 |
| `pnpm test:e2e` | **6/6 通过**；桌面和 320px 移动 Chromium，包含 axe、手动加载、合成 MRT、错误恢复、ASN 深链接和在途重置 |
| Wrangler `deploy --dry-run` | 通过；仅本地输出验证，没有部署 |
| 33 个跟踪 JS 文件语法检查、`git diff --check` | 通过 |
| `pnpm audit --json` | 退出 1：1 moderate（minimatch），无机器报告的 high / critical；人工公告阻塞仍在 |
| `pnpm audit --audit-level=high` | 退出 0；不表示人工已核实的公告已修复 |
| `pnpm test:functional` | Windows Vite SSR 模块加载失败，`transport invoke timed out after 60000ms`；退出 1，后续 path-diagram 脚本未由该串联命令执行 |
| 单独 `node scripts/verify-path-diagram.mjs` | 通过；共享节点、分叉、相同、前缀包含、不相交及重汇聚路径断言 |

首轮数据下载测试受默认沙箱临时目录的文件重命名权限影响，改用工作区临时目录后通过，未修改下载实现。另修正测试 JSON 映射键和生产 Worker 文件匹配的 Windows 路径分隔符，保留所有断言。浏览器首轮因沙箱的 localhost `EACCES` 无法启动 workerd；允许本地回环连接后原测试全部通过，测试仍拦截外部请求及真实 BGP 下载。已检查桌面拓扑和移动路径截图。

手动生命周期脚本在默认沙箱及允许本地连接的环境均于首次页面 SSR 加载超时；失败对象分别包括 `components/ui/dialog.tsx` 和 `lib/bgp/source.mjs`。未放宽超时、跳过断言或将其计为通过。标准构建、生产浏览器回归与 Worker 验证的成功不能替代该失败项。远端精确提交的 CI 结果以 PR #4 最终 head 的检查为准。

## 历史记录：2026-11-06 本轮修补前

以下保留修补前远端 CI 与原 head 的证据；其中“当前”“本轮”和阻塞结论仅适用于当时版本，应以上方候选锁审查为最新状态。

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
