# 浏览器模式验证

```sh
pnpm run lint
pnpm run typecheck
pnpm run bgp:test
pnpm run test:functional
pnpm exec wrangler deploy --dry-run
pnpm run test:worker
pnpm exec playwright install --with-deps chromium
pnpm run test:e2e
```

需要 Node（版本以 `.node-version` 为准）、锁定的 pnpm 和 Python 3。浏览器检查先构建生产产物，再由 Playwright 启动本地 Wrangler；不复用已有服务器、不部署、不需要 Cloudflare 凭据。`test:worker` 使用 Node 独立线程，`test:e2e` 使用真实 Chromium，分别验证相同生产 Worker 产物。

自动化检查覆盖：

- 原始/gzip/bzip2 输入分块读取；多块和拼接 bzip2、CRC、截断输入。
- IPv4/IPv6 最长前缀匹配，/0、/32、IPv6 地址规范化，独立 peer session。
- AS4_PATH、AS_SET、confederation、重复 ASN、ADDPATH 冲突及内存边界。
- 原始字节流转发无需 storage binding；输入日期校验；错误状态；旧查询/上传入口 410。
- 首次加载不会请求数据；获取成功前禁止查询；取消/失败保留旧数据；新数据成功后原子切换。
- 路径图的共同前缀只展示一次，完全相同、前缀包含、分离和重新相交的路径保留各自顺序。
- Chromium 的桌面 1440px / 移动 320px 视口：两页和查询结果无横向溢出；跳至主要内容、导航与对话框焦点；axe WCAG A/AA 规则。
- Chromium 只在点击后读取仓库已有拓扑快照；合成 bzip2 MRT 文件通过真实浏览器 Worker 导入、查询；IPv4/IPv6 session 切换显示缺失地址族或对应路径；无效 IP、损坏输入显示错误，已有有效数据仍可查询，刷新后清空。

真实浏览器导入还验证 Worker URL 与站点同源：`bgp-client.ts` 使用 Vite 的 `?worker&url` 导入，避免 vinext 将 `import.meta.url` 改写为 `file://` 后导致浏览器拒绝加载。单独运行 Node Worker 产物无法发现该页面集成问题。

以上自动化检查均接入每个 PR 和 `main` push 的 Actions。浏览器检查禁止外域和 BGP 转发请求，全部输入来自合成样本或仓库现有 JSON。桌面/移动端拓扑与合成路径截图及失败详情保存在 `test-results/`（不提交），CI 上传到本仓库，保留 7 天。

人工浏览器验收：打开 `/paths`，点击获取并观察进度，取消再重试；导入 HKIX 文件后比较两个 IP，切换观测 session；刷新后应清除内存数据。拓扑页需点击「获取拓扑数据」才加载 CAIDA 快照。

性能随文件大小、压缩比例和用户设备而异；不再沿用旧版 R2 查询的 Worker CPU 基准或 10ms 认证结论。

## 历史本地验证（2026-09-28）

全部 11 项合成测试、TypeScript、修改文件 ESLint、客户端生命周期检查及生产构建通过。生产 Worker bundle 在独立 JS 线程完成下载、解压、文件导入、查询和错误处理；本地 Cloudflare HTTP 服务可返回网页、浏览器 Worker 资源以及预期的 400/410 响应，无存储 binding。

另以真实 `rib.20260927.0000.bz2`（41,550,669 字节）运行同一浏览器解析模块：收录 1,308,637 条路由，其中 IPv4 1,065,904 条、IPv6 242,733 条。Cloudflare/Google 两组 IPv4 和 IPv6 样例的前缀与 AS_PATH 均与修改前的独立 Python MRT 解析器一致。Node 环境全量解析约 32 秒；该时间不是终端浏览器性能承诺。

当时执行环境没有可用的 Chromium，浏览器运行时下载被网络环境阻止，未完成真实浏览器 UI 自动化。该历史 Worker 产物验证使用 Node 标准 Web API 和独立线程；现行 CI 的 Chromium 覆盖见上文，不重新下载该真实 RIB 文件。
