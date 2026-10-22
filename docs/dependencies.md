# 依赖审查（2026-10-22）

整合 PR #4、#5、#6 后，完整 `pnpm audit --json` 仍退出 1：**1 high（braces 3.0.3），0 critical / moderate / low**。因此不能合并，也不能把功能检查通过称为依赖审计通过。

## 已完成的修补

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

## 剩余合并阻碍

[braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 的深层嵌套模式可导致栈耗尽。2026-10-22 官方公告仍标注无补丁，npm 最新仍是 3.0.3，不能将未发布的 3.0.4 当成修复。两条路径为：

- `eslint-config-next@16.3.8 > @next/eslint-plugin-next@16.3.8 > fast-glob@3.3.1 > micromatch@4.0.8 > braces@3.0.3`。
- `vinext@1.0.1 > vite-plugin-commonjs@0.10.4 > vite-plugin-dynamic-import@1.6.0 > fast-glob@3.3.3 > micromatch@4.0.8 > braces@3.0.3`。

截至复核，最新 Next ESLint 16.4.2、Vinext 1.3.0 和各 glob 父包仍保留此链。fast-glob [#535](https://github.com/mrmlnc/fast-glob/pull/535) 已关闭未合并、[#536](https://github.com/mrmlnc/fast-glob/pull/536) 尚未发布。其他 brace/glob 包不提供相同导出及同步解析语义；本轮没有用不兼容别名或自造版本规避告警。

当前 `next.config.ts` 为空，也未配置 Next ESLint `settings.next.rootDir`，未发现网页输入进入上述 glob 路径；这不等于漏洞已修补，完整 high 阈值仍失败。通用 CI 的强制审计继续阻断合并。

## 验证边界

复核命令为 `pnpm install --frozen-lockfile`、`pnpm peers check`、`pnpm audit --json` 和 `pnpm audit --audit-level=high`。功能检查包括 lint、typecheck、20 项标准测试、生命周期/路径图、生产构建、生产浏览器 Worker 及桌面/移动 Chromium；每项是否执行与结果以 PR 的最终 head 报告为准。

Vinext 1.0.1 将浏览器 Worker 放入 `_next/static/workers/`；产物验证改为递归查找且要求恰好一个 Worker，仍执行合成解压、查询和错误路径。浏览器回归增加 ASN 深链接的手动加载与请求完成前返回全球视图，确保迟到响应不能覆盖用户操作。

本仓库只保留固定 SHA 的通用 workflow，未恢复旧独立审计或 UI 工作流。通用 CI 强制审计包括开发依赖；生命周期、Worker 和浏览器检查源码保留为手动验证。历史 61 条基线归因保留于 [2026-10-13 记录](bgp/dependency-attribution.md)，不是当前整合后的审计结果。没有手动部署、修改凭据或生产资源。
