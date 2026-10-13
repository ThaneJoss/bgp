# CI：使用通用自动发现模板

`.github/workflows/ci.yml` 只调用 [ThaneJoss/github-ci 的固定版本](https://github.com/ThaneJoss/github-ci/blob/89624ba02d911171a634ddeb4848c298f3b1c842/.github/workflows/ci.yml)。调用方没有 inputs、env、secrets 或专属步骤，使用 push、pull_request、merge_group 和 workflow_dispatch 触发，仅授予 `contents: read`。

原独立质量工作流 `bgp-checks.yml` 和 `site-checks.yml` 已删除。测试源码与业务代码保留；Node 数据迁移提供标准 `test`（MRT/查询/转发与固定小型 CAIDA 流程）、`typecheck` 和原 `lint` / `build`，由通用模板自动发现。没有项目专属 CI 步骤、模板修改或安全豁免。

PR #5 原始 head 因 `scripts/data/requirements.txt` 被自动发现拒绝，安装和检查未执行。本次将对应 Python 工具等效迁为 Node 后删除 requirements，并为 standalone 根项目声明 `packages: ['.']`；保留原安装策略、版本固定及冻结锁文件。工具说明与明确的算法差异见 [离线数据工具](data-tools.md)。外部通用模板本身的 Python 编排不属于本仓库的工具运行依赖。

通用模板顺序执行 lint、typecheck、test、build、JS 语法和强制 high 级依赖审计；任一步失败会阻断后续步骤。为让迁移测试到达执行阶段，本分支提取 PR #4 已有的五处最小 hooks lint 修复，未纳入其样式、Worker 或依赖升级。未执行的检查以及 `NOT RUN` 不等于通过，必须按精确 head 的实际 CI 日志报告。客户端生命周期、Wrangler dry-run、Worker 产物、浏览器/无障碍专属检查未恢复；原验证脚本仍可手动运行。

本仓库默认分支没有发布、部署或自动数据更新 workflow，因此没有此类文件需要删除或迁移。原有 Cloudflare GitHub 集成在 Actions 工作流之外，保持原有配置，分支 push 可能自动创建预览。通用 CI 不执行发布、RouteViews 下载、SQLite 构建或数据写入。

迁移分支基于未合并的 PR #5，draft PR 指向其分支以隔离数据迁移差异。PR #4 尚未合并，其两份组件文件与本次最小 hooks 修复重叠，package/文档也需后续协调；其依赖修复未纳入本分支。审阅或合并时需保留通用 CI，避免重新引入已替代的专属质量工作流。没有合并、关闭其他 PR 或触发外部 review bot。
