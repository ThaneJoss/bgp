# BGP 查询的 Workers Free 预算与验收

本文只讨论 `workers/bgp` 的独立查询 API。每日 MRT 解压、解析、最长前缀匹配编译、路径去重与 diff 在离线任务中完成，不在用户请求或 Worker Cron 中执行。页面的 React / SSR 开销不能用查询 API 的结果代替验证。

## 结论边界

实现通过固定输入大小、二进制索引和 R2 Range 限制每次查询的工作量。设计目标是 Workers Free 的 **10 ms CPU / HTTP 请求**，但本地 Node 或 workerd 基准不能证明 Cloudflare 边缘已经满足这个限制。正式验收必须读真实调用的 Cloudflare CPU 指标。当前没有因本文或验收脚本而部署 Worker、下载 MRT 或触发生产任务。

## 官方限制

核对日期：2026-09-22。

| 项目 | Workers Free | 对本实现的影响 |
|---|---:|---|
| 每个 HTTP 请求的 CPU | 10 ms | 小索引、有限二分查找、有限序列化 |
| 每个 isolate 的内存 | 128 MB | 不加载全量路径库；并发请求共享这个上限 |
| 每日请求 | 100,000 | 独立于 R2 免费读取额度 |
| 同时等待的出站连接 | 6 | 每个 IP 按 index → page → path 依次读取，两 IP 可并行 |

CPU 是执行代码所用时间，等待 R2 / 网络 I/O 的时间不计入 CPU。R2 响应解析、缓冲、边界校验、JSON 编解码仍然有执行开销。因此一次 100 ms 的 HTTP 响应不意味着超过 10 ms CPU，一次本地 1 ms 的响应也不意味着所有边缘节点必然合格。

免费套餐的限制由平台执行，不在 Wrangler 中写只对付费 Standard 开放的 `limits.cpu_ms`。本地开发不执行生产 CPU 限制。

## 每次查询的数据上界

具体格式见 [format.md](bgp/format.md)。对比固定为两个 IP、同一个已选观测 peer，整个请求只读取一次 manifest。

| 部分 | 上界 |
|---|---:|
| latest manifest | 65,536 bytes |
| 每个地址族的页索引 | 262,144 bytes |
| 每个 IP 的记录页 | 1,024 × 24 = 24,576 bytes |
| 每个 IP 的有序 AS_PATH | 256 × 4 = 1,024 bytes |
| 两 IP 不同地址族、全冷查询总读取 | 最多 641,024 bytes（约 626 KiB） |
| 同地址族两 IP | 最多 6 次 R2 GET |
| 不同地址族两 IP | 最多 7 次 R2 GET |

同一请求中复用相同 peer / 地址族的索引读取。没有依赖 isolate 热缓存才能符合上述上界；冷实例也不需要加载整个路由库。R2 使用明确的 `offset`、`length` 读取索引指向的范围，版本路径不可变，因此一次对比不会混用两天的数据。

最长前缀匹配已经离线转为非重叠地址区间。线上对页索引及一个记录页二分查找；这不是整个查询的严格 O(1)。尤其索引完整性验证仍然与索引大小有关，必须包含在基准里，不能只展示二分函数的耗时。路径长度、manifest 和索引大小也有硬上限，离线生成越界时应停止发布，不能静默丢路由。

## 已执行的本地基准

```sh
node scripts/bgp/bench-query.mjs --iterations 1000
node --test scripts/bgp/check-worker-cpu.test.mjs
```

基准调用实际 `handleRequest`，用合成二进制数据和内存 R2 mock，覆盖 body 复制、完整性验证、二分查找、JSON 响应及响应 body 消费。没有网络、下载或真实 BGP 数据。每次都重新读 manifest / index；只有同一个双 IP 请求内部复用索引。

2026-09-22、Node v24.19.0 的一次结果如下，原始输出见 [local-query-benchmark.json](bgp/local-query-benchmark.json)。这些结果不是 Workers CPU 指标，也不是公开互联网延迟。

| 合成场景，每场景 1,000 次 | Node 进程平均 CPU / 次 | 本地墙钟 p99 | R2 GET / 次 | 读取字节 / 次 |
|---|---:|---:|---:|---:|
| 每族约 130 万区间，两个 IPv4 | 0.289 ms | 0.591 ms | 6 | 81,744 |
| 每族约 130 万区间，IPv4 + IPv6 | 0.340 ms | 0.866 ms | 7 | 112,224 |
| 索引、manifest、路径均达格式上限，IPv4 + IPv6 | 0.744 ms | 1.424 ms | 7 | 640,992 |

上限场景每族 10,922 个索引项、每页 1,024 条记录、路径 256 个 ASN、manifest 65,536 bytes。索引最大实际长度为 262,128 bytes，因为记录长 24 bytes。约 1,118 万条虚拟区间 / 族只用于测试上限，**不是声称真实采集器有这么多路由**；mock 仅生成被查询的数据页。

上述分位数在 25 次预热之后记录。首个进程内 handler 调用墙钟约 **9.07 ms**，此前另一次试跑超过 **11 ms**，说明不能用预热平均数掩盖首次执行的开销。Node 进程 CPU 还包括 mock、GC 和运行时线程；首调用墙钟也不是 Cloudflare 的 CPU。当前结论是“固定工作量且本地基准有余量，线上尤其冷实例仍待验收”，不能写成“已经证明 Free 全部请求小于 10 ms”。

## 线上验收

1. 为独立查询 Worker 开启 `observability.enabled`，验收期间采样率设为 1，并保留 invocation logs。Workers Logs 在免费计划有 200,000 条事件 / 天、3 天保留期；无需额外使用付费日志导出产品。
2. 在真实已发布快照上分别采集冷实例 / 冷数据读取、重复查询、随机 IPv4、随机 IPv6、IPv4 + IPv6 对比、无路由以及最长路径样本。每类分别核对，不能让大量缓存命中掩盖冷查询。
3. 从 Cloudflare Observability 导出 **invocation** 记录，必须包含平台测量的 CPU 时间和 outcome。不要把浏览器响应时间、Worker 内的 `performance.now()` 或自己记录的业务耗时改名为 CPU。
4. 在本地运行下面的脚本；它只读本地日志文件，不会请求 API。

```sh
node scripts/bgp/check-worker-cpu.mjs invocation-logs.jsonl
```

默认发布验收条件：每类至少 1,000 个 CPU 样本、p99 ≤ 5 ms 为变化留余量、最大值 < 10 ms、所有 invocation outcome 为 `ok`。这是项目预算阈值，不是 Cloudflare 额外规定。缺 CPU 字段、样本不足或 `exceededCpu` 都失败。合法但预期的 400 / 404 请求应独立核对，不混入正常查询性能样本。

脚本接受 JSON 数组、`events` / `result` 数组容器和 JSONL；默认识别 `$workers.cpuTimeMs` / `cpuTimeMs` / `CPUTimeMs` 及对应 outcome。若导出结构不同，用实际字段指定，例如：

```sh
node scripts/bgp/check-worker-cpu.mjs invocation-logs.jsonl \
  --cpu-field '$workers.cpuTimeMs' --outcome-field '$workers.outcome'
```

脚本不能认证日志来源；传入合成日志只能检查验收脚本自身，不能证明部署性能。线上某一批样本通过也不保证未来所有数据和 runtime 版本都通过，应继续观察 `exceededCpu` 与分位数。

Cloudflare 为安全原因使线上 `performance.now()` / `Date.now()` 通常仅在 I/O 后前进，因此用它们包住纯计算可能得到 0 ms。那不是“没有 CPU 开销”。本地运行没有这项计时行为限制，但硬件、V8 版本、调度和真实绑定实现仍然不同。

## 官方依据

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Wrangler limits：本地不执行生产限制](https://developers.cloudflare.com/workers/wrangler/configuration/#limits)
- [Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)
- [R2 ranged reads](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#ranged-reads)
- [Workers Logs 与免费配额](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [平台 CPU 与 wall time 指标](https://developers.cloudflare.com/changelog/post/2025-04-09-workers-timing/)
