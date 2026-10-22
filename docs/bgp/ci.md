# CI：使用通用自动发现模板

`.github/workflows/ci.yml` 只调用 [ThaneJoss/github-ci 的固定版本](https://github.com/ThaneJoss/github-ci/blob/89624ba02d911171a634ddeb4848c298f3b1c842/.github/workflows/ci.yml)。调用方没有 inputs、env、secrets 或专属步骤，使用 push、pull_request、merge_group 和 workflow_dispatch 触发，仅授予 `contents: read`。

原独立质量工作流 `bgp-checks.yml`、`site-checks.yml` 及旧 UI 分支新增的 `dependency-audit.yml` 均已移除；保留全部测试源码与 package scripts。Node 数据迁移提供标准 `test`（MRT/查询/转发与固定小型 CAIDA 流程）、`typecheck` 和原 `lint` / `build`，由通用模板自动发现。没有项目专属 CI 步骤、模板修改或安全豁免。

PR #5 原始 head 因 `scripts/data/requirements.txt` 被自动发现拒绝。PR #6 将对应 Python 工具迁为 Node 后移除该 requirements，并为 standalone 根项目声明 `packages: ['.']`，保留安装策略、版本固定及冻结锁文件。算法差异见 [离线数据工具](data-tools.md)。外部模板的 Python 编排不属于本仓库工具运行依赖。

通用模板顺序执行 lint、typecheck、test、build、JS 语法和强制 high 级依赖审计；任一步失败会阻断后续步骤。未执行的检查以及 `NOT RUN` 不等于通过，必须按精确 head 的实际 CI 日志报告。客户端生命周期、Wrangler dry-run、Worker 产物、浏览器/无障碍检查保留为手动验证，不恢复独立 workflow，也不伪称通用 CI 执行了它们。

浏览器测试使用 1440px 桌面及 320px 触摸视口，覆盖初始状态、键盘导航、对话框焦点、横向溢出、axe WCAG A/AA、手动加载拓扑、真实浏览器 Worker 导入、session 切换及错误恢复。测试会阻断外域及 `/api/bgp/download` 请求，全部输入为本地合成 MRT 或仓库已有 JSON；截图和失败 trace 写入本地 `test-results/`。自动检查不能替代人工屏幕阅读器验收。

本仓库没有发布、部署或自动数据更新 Actions workflow。原 Cloudflare GitHub 集成保持不变，push/merge 可能自动构建；通用 CI 不执行发布、RouteViews 下载或生产数据写入。合并前后须分别核对 Actions 和既有自动构建的实际终态。

当前依赖阻碍及复核依据见 [依赖审查](../dependencies.md)。没有降低审计阈值、添加忽略项、吞错或修改分支保护。
