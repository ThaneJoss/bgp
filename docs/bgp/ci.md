# CI：仅验证代码，不自动更新数据

`bgp-daily.yml` 已删除。没有 cron、RouteViews 下载、SQLite 构建、快照发布或数据保留清理任务。

- `bgp-checks.yml`：每个 PR 都运行 Node 标准库测试，用 Python 标准库生成合成 bzip2 样本，验证流式解压、MRT、session、IPv4/IPv6 LPM、损坏文件和按需转发。没有路径过滤，修改 Node 版本或依赖也会运行。
- `site-checks.yml`：安装锁定依赖，依次运行全仓库 ESLint、TypeScript、客户端生命周期与路径图渲染检查、Wrangler dry-run 生产构建、生产浏览器 Worker 产物检查、真实 Chromium 集成测试。

两者保留 pull request、主分支 push 和手动触发，只读仓库权限，不要求 Cloudflare 凭据，不访问 BGP 上游。`wrangler deploy --dry-run` 仅构建并验证产物，没有发布步骤。依赖和 Chromium 由安装步骤获取；应用测试只访问本地站点、仓库现有 CAIDA JSON 和合成 MRT 数据。

浏览器测试使用 1440px 桌面及 320px 触摸视口，覆盖两页初始状态、跳至主要内容、活动导航、对话框焦点、横向溢出、axe WCAG A/AA 规则、手动加载拓扑，以及真实浏览器 Worker 导入、查询、错误后保留数据和刷新后清空数据。测试会阻断并报告外域请求和 `/api/bgp/download` 请求，防止误触发真实路由下载。仅在此仓库的 Actions 保存桌面/移动端拓扑与合成路径截图，以及失败时的 trace 等测试产物，保留 7 天。

自动化无障碍检查无法替代屏幕阅读器和人工操作验收；未配置或修改分支保护规则。
