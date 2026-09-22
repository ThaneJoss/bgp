# bgp / AS Atlas

每日离线生成自有 BGP 路径库，Cloudflare Worker 查询时只读取自己的 R2 数据。前端保留全球 AS 拓扑与两 IP 路径对比。**提交代码和运行测试不会下载真实路由数据；定时采集默认关闭。**

## 数据范围

- 唯一采集器：RouteViews **hkix.hkg / 香港 HKIX**。
- 默认固定 **AS3491 Console Connect/PCCW** 两个 session：IPv4 `123.255.90.244`，IPv6 `2001:7fa:0:1::ca28:a0f4`。
- 香港采集器及上述 AS 不等于中国大陆内部视角。当前公开 collector 元数据未找到可选的大陆 collector。
- 两个 session 分开保存，**不会伪造一个共同的双栈 peer**。比较两 IP 时必须是同一个真实 session；缺失的地址族会明确显示。
- 展示采集器 peer 所见的有序 AS_PATH，不是任意两个 IP 的真实 A→B / B→A traceroute，也不是全球全部可用路径。
- 原始 AS prepends 在库/API 中保留，前端合并连续重复 AS。AS_SET/confederation 或冲突 ADDPATH 保留其前缀遮盖关系，并返回 `unsupported_path`，不会错误回退到更短前缀。

## 结构

| 路径 | 用途 |
| --- | --- |
| `config/bgp-collector.json` | 固定采集器、peer allowlist、覆盖与存储上限 |
| `scripts/bgp/mrt.py` | 标准库流式 MRT TABLE_DUMP_V2 / gzip / bzip2 解析 |
| `scripts/bgp/build_snapshot.py` | 两遍输入扫描、SQLite 外排、LPM 区间、路径去重、每日 diff |
| `workers/bgp/src/index.mjs` | 独立的极简查询 Worker，无 React / SSR 导入 |
| `.github/workflows/bgp-checks.yml` | 合成测试与本地基准，不访问 BGP 上游 |
| `.github/workflows/bgp-daily.yml` | 显式启用后下载每日 00:00 UTC RIB，构建并发布 |
| `public/bgp-service.json` | 前端查询 API 地址；空字符串表示同源 `/api/bgp/*` |
| `docs/bgp/ci.md` | CI 变量、Secrets、首次发布与保留策略 |
| `docs/bgp/format.md` | 二进制索引与 API 约定 |
| `docs/worker-free-budget.md` | Free CPU 分析、测量结果及线上验收 |

发布顺序是：下载固定日期文件 → 解析并检查覆盖 → 生成索引和前日 diff → 校验文件哈希与大小 → 上传不可变版本文件 → 条件写入 `latest.json` → 清理旧版本。失败时查询继续使用上一份已发布快照。完整快照保留两份，独立 diff 默认保留七份；原始 MRT 和 SQLite 工作文件不上传。

## 免费额度与验证边界

查询 Worker 每 IP 读取一个稀疏索引、最多 24 KiB 的记录页和最多 1 KiB 的路径。比较两 IP 共用同一份 manifest 和 peer，同地址族最多 6 次 R2 GET，不同地址族最多 7 次。格式上限是 manifest 64 KiB、每族索引 256 KiB、路径最多 256 个 ASN。

这是**有界的索引查询，并非严格 O(1)**。索引/记录使用二分查找，结构验证只遍历有上限的小块。最关键的是用户请求不会扫描或解析整份 RIB，也不会回源公共 JSON API。

Cloudflare Workers Free 的 HTTP CPU 限额是 10 ms。Node 合成基准已有结果，但**不证明 Cloudflare 线上 CPU 达标**，尤其冷启动；没有真实部署日志时必须保持 `cloudflare10msVerified: false`。验收脚本要求至少 1,000 个平台 CPU 样本、p99 ≤ 5 ms、max < 10 ms、没有 CPU 超限/非正常 outcome。详见预算文档。

计算可使用 GitHub 公开仓库的标准免费 Ubuntu runner。R2 Standard 有免费额度，但属于超额计费服务。配置限制整个专用桶在发布临时版本时仍不超过 8 GiB，读写操作也需监控；代码不创建账户、桶或计费订阅。

## 本地检查（不下载 BGP）

需要 Python 3.12+、Node 22.13+。BGP 核心和以下测试只使用标准库：

```sh
python3 -m unittest discover -s tests/bgp -p 'test_*.py'
python3 scripts/bgp/test_pipeline.py
node --test tests/bgp/query.test.mjs scripts/bgp/check-worker-cpu.test.mjs
node scripts/bgp/test-e2e.mjs
node scripts/bgp/bench-query.mjs --iterations 1000
```

跨语言测试把合成前缀交给 Python 构建器，再由真实 Worker handler 查询生成的二进制文件，对照独立最长前缀匹配结果。CI 不依赖 BGP 数据下载或 Cloudflare 凭据即可运行这些检查。

已有本地 MRT 才运行以下离线构建命令；它本身不联网：

```sh
python3 scripts/bgp/build_snapshot.py \
  --input /path/to/local-rib.bz2 \
  --output _bgp/snapshot \
  --config config/bgp-collector.json \
  --snapshot-id 20260922T000000Z \
  --data-time 2026-09-22T00:00:00Z
```

随后按 `docs/bgp/ci.md` 配置自己的 R2，并手动确认首次下载/发布。`BGP_INGEST_ENABLED` 未设为 `true` 时每日任务不采集；手动 workflow 也要求明确勾选确认。这里没有启动任何真实数据任务。

## 前端与个人 Cloudflare 部署

前端沿用现有 React/Vinext 工程和锁文件，安装依赖后 `npm run dev` / `npm run build`。拓扑视图的 CAIDA 静态数据与每日路径库独立，不会因 BGP CI 更新而改变。

查询必须直达独立 Worker，不能为了方便代理穿过网页 SSR Worker，再声称查询预算相同：

1. 修改 `workers/bgp/wrangler.jsonc` 的桶名和 `APP_ORIGIN`，使其对应自己的资源与网站完整 origin。
2. 自行部署查询 Worker（`npm run bgp:worker:deploy`）。仓库不会自动部署或创建 R2 桶。
3. 在 `public/bgp-service.json` 设置 `{"apiBase":"https://你的查询Worker.workers.dev"}`；或在自己的 Cloudflare zone 将 `/api/bgp/*` 路由至该 Worker，并保持空字符串。
4. 首份快照成功发布后，网页从 `/api/bgp/manifest` 读取可用视角，通过单次 `/api/bgp/compare` 对比两 IP。

未配置服务时页面明确显示路径库未接通，不展示模拟路径。旧 `/api/paths` 已停用，没有 RIPEstat fallback。现有 `.openai/hosting.json` 仅对应此前的网站托管；个人查询 Worker 使用自己的 Wrangler 配置，两者相互独立。

线上验收使用从 Cloudflare Workers Logs 导出的真实 invocation 日志：

```sh
node scripts/bgp/check-worker-cpu.mjs /path/to/invocations.jsonl
```

不存在平台 CPU 字段、样本不足或出现超限时，脚本拒绝判定通过。还需分别覆盖首次调用、无缓存、IPv4/IPv6、最长路径与数据更新切换。

## 数据来源与署名

- RouteViews HKIX archive: https://archive.routeviews.org/hkix.hkg/bgpdata/
- RouteViews collector metadata: https://api.routeviews.org/collector/53/
- RouteViews data attribution/license: https://www.routeviews.org/routeviews/licenses/
- CAIDA AS Relationships / AS-to-Organization: https://www.caida.org/catalog/datasets/as-relationships/ 和 https://www.caida.org/catalog/datasets/as-organizations/
- 界面参考：https://github.com/thanejoss/webapps

RouteViews 与 CAIDA 数据各自遵循其来源条款。代码仓库不改变数据集的许可。当前 CAIDA 拓扑是明确标注日期的静态快照，关系是推断的 AS 连接，不代表物理链路或带宽。
