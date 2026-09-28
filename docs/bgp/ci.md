# CI：仅验证代码，不自动更新数据

`bgp-daily.yml` 已删除。没有 cron、RouteViews 下载、SQLite 构建、快照发布或数据保留清理任务。

- `bgp-checks.yml`：Node 标准库测试，用 Python 标准库生成合成 bzip2 样本，验证流式解压、MRT、session、IPv4/IPv6 LPM、损坏文件和按需转发。
- `site-checks.yml`：安装锁定依赖、TypeScript、浏览器客户端生命周期检查、Wrangler dry-run 构建。

两者保留 pull request、主分支 push 和手动触发，只读仓库权限，不要求 Cloudflare 发布数据的凭据，不访问 BGP 上游。

在此变更合并到默认分支之前，默认分支的旧定时任务仍会按原配置运行。已有运行中的旧任务不会因删除文件自动取消。
