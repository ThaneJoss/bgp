# CI：使用通用自动发现模板

`.github/workflows/ci.yml` 只调用 [ThaneJoss/github-ci 的固定版本](https://github.com/ThaneJoss/github-ci/blob/89624ba02d911171a634ddeb4848c298f3b1c842/.github/workflows/ci.yml)。调用方没有 inputs、env、secrets 或专属步骤，使用 push、pull_request、merge_group 和 workflow_dispatch 触发，仅授予 `contents: read`。

原独立质量工作流 `bgp-checks.yml` 和 `site-checks.yml` 已删除。其显式合成测试、TypeScript、客户端生命周期、Wrangler dry-run 和生产 Worker 产物检查不再作为专属 CI 步骤保留。测试源码、package scripts 和业务代码继续保留，通用模板从标准元数据决定实际执行的检查；本次没有改写脚本名或添加配置来恢复旧覆盖。

固定模板的本地自动发现先报错：`Unsupported dependency/build metadata: ['scripts/data/requirements.txt']; retain explicit mode`。仓库现有数据工具的 pip requirements 不符合该模板的自动发现契约，本次按迁移范围保留这些文件，未改用专属 profile 或删除依赖文件来规避失败。此外，`pnpm-workspace.yaml` 仅包含安装策略，没有模板要求的字面量 `packages` 列表，是后续可能遇到的兼容限制。

自动发现失败意味着后续安装、lint、类型、测试、构建和审计未执行，不能称为通过。模板若未发现某项检查，其 `NOT RUN` 也不等同于检查通过；远端 PR 检查须按实际结果报告。

本仓库默认分支没有发布、部署或自动数据更新 workflow，因此没有此类文件需要删除或迁移。原有 Cloudflare GitHub 集成在 Actions 工作流之外，保持原有配置，分支 push 可能自动创建预览。通用 CI 不执行发布、RouteViews 下载、SQLite 构建或数据写入。

界面改进 PR #4 尚未合并，并修改了同名旧工作流且新增独立审计。它与本次迁移存在重叠；今后审阅或合并时需处理这些冲突，避免重新引入已替代的专属质量工作流。迁移 PR 不包含该 PR 的界面、依赖或测试改进。
