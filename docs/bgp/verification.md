# 浏览器模式验证

```sh
pnpm run bgp:test
pnpm exec tsc --noEmit
node scripts/verify-functional.mjs
pnpm run build:cloudflare
```

自动化检查覆盖：

- 原始/gzip/bzip2 输入分块读取；多块和拼接 bzip2、CRC、截断输入。
- IPv4/IPv6 最长前缀匹配，/0、/32、IPv6 地址规范化，独立 peer session。
- AS4_PATH、AS_SET、confederation、重复 ASN、ADDPATH 冲突及内存边界。
- 原始字节流转发无需 storage binding；输入日期校验；错误状态；旧查询/上传入口 410。
- 首次加载不会请求数据；获取成功前禁止查询；取消/失败保留旧数据；新数据成功后原子切换。

人工浏览器验收：打开 `/paths`，点击获取并观察进度，取消再重试；导入 HKIX 文件后比较两个 IP，切换观测 session；刷新后应清除内存数据。拓扑页需点击「获取拓扑数据」才加载 CAIDA 快照。

性能随文件大小、压缩比例和用户设备而异；不再沿用旧版 R2 查询的 Worker CPU 基准或 10ms 认证结论。

## 本次本地验证（2026-09-28）

全部 11 项合成测试、TypeScript、修改文件 ESLint、客户端生命周期检查及生产构建通过。生产 Worker bundle 在独立 JS 线程完成下载、解压、文件导入、查询和错误处理；本地 Cloudflare HTTP 服务可返回网页、浏览器 Worker 资源以及预期的 400/410 响应，无存储 binding。

另以真实 `rib.20260927.0000.bz2`（41,550,669 字节）运行同一浏览器解析模块：收录 1,308,637 条路由，其中 IPv4 1,065,904 条、IPv6 242,733 条。Cloudflare/Google 两组 IPv4 和 IPv6 样例的前缀与 AS_PATH 均与修改前的独立 Python MRT 解析器一致。Node 环境全量解析约 32 秒；该时间不是终端浏览器性能承诺。

当前执行环境没有可用的 Chromium，浏览器运行时下载被网络环境阻止，所以未完成真实浏览器 UI 自动化。上面的 Worker 产物测试使用 Node 标准 Web API 和独立线程，不等同于 Chromium 端到端测试。
