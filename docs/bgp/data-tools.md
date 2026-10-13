# Node.js 离线数据工具

使用根 package.json / pnpm-lock.yaml，Node 22.13+、pnpm 11；没有 Python、pip、NetworkX、NumPy 或系统 bzip2 可执行文件的运行依赖。加工工具保持维护者离线流程，浏览器仍按需读取静态 CAIDA JSON，并在原 Web Worker 中解压、解析和查询 MRT；Cloudflare `/api/bgp/download` 仍转发原始字节流。

```sh
pnpm install --frozen-lockfile
# 此命令会访问 CAIDA 并下载两份最新归档，仅需更新数据时手动执行。
pnpm run data:fetch --data-dir /path/to/local-inputs
pnpm run data:communities --data-dir /path/to/local-inputs
pnpm run data:snapshot --data-dir /path/to/local-inputs
pnpm run data:explorer --source /path/to/local-inputs --output /path/to/explorer --target-size 240
```

前三个命令默认目录为 `scripts/data/`，可用 `--data-dir` 指定；explorer 保留必需的 `--source` / `--output` 及默认 240 的 `--target-size`。`sources.json` 仍给出原始 relationship/organization 文件名、URL、日期与字节数，新下载添加 `fetchedAt` / `fetchedDate`。目录须含本地原始归档；explorer 从 snapshot 日期寻找 `YYYYMMDD.as-rel.txt.bz2`，与旧工具一致。下载失败不发布部分 sources.json；文件先写 `.part` 再替换。

## 图算法与确定性

Louvain 使用 [graphology-communities-louvain](https://graphology.github.io/standard-library/communities-louvain.html) 2.0.2 和 Graphology 0.26.0（MIT）。图仍为完整、简单、无向、无权 AS 图：重复和反向 ASN 对只形成一条边。节点按 ASN 升序、边按规范无向对升序插入；resolution 1、seed 42、显式 mulberry32 PRNG、randomWalk true、fastLocalMoves false。结果保留原社区计数、尺寸、modularity 和 merge 字段，并记录实际实现版本、PRNG 和输入排序，替代新结果中不适用的 networkxVersion。

Graphology 的移动顺序、收敛逻辑和 PRNG 与 NetworkX 3.7 不同，种子数值相同不保证相同社区、modularity、代表 ASN、组名、图块或坐标。确定性针对同一锁定依赖、规范图及运行环境；不声称跨实现或所有未来版本逐字节一致。modularity 使用无向 Newman 公式，self-loop 在算法 degree 中计两次。检测后仍按真实边拆分不连通社区；多于 20 个时，将最小社区并入观察边最多的相邻社区，平局先选目标大小、再选最小 ASN。没有相邻目标时明确报错，保留旧工具的限制，不创造连接。

snapshot 对给定社区划分保留最高度/最小 ASN 代表、组织种子、社区内 BFS 最短距离、120 个预览成员和 1500 条预览边上限。它也能读取已有 NetworkX communities.json，保留其真实来源；新工具不会替换历史静态快照的算法说明。

图块沿用按邻居度数降序、ASN 升序的 BFS、等分且不超过 target-size 的叶块，以及 256 个 `ASN % 256` 邻接/名称分桶。布局改为独立 JavaScript Fruchterman–Reingold：真实无权边、28 次迭代、`k=1.65/sqrt(V)`、xorshift32 固定种子、中心化、归一化至 [-1,1]、5 位小数。其 RNG、标量运算及固定迭代与 [NetworkX spring_layout](https://networkx.org/documentation/stable/reference/generated/networkx.drawing.layout.spring_layout.html) 的 NumPy RNG、数组运算及提前停止不同；manifest 明确标注新实现。图块允许不连通分量，布局不添加虚构边。

## 输出兼容与输入边界

保留 topology、metadata、ASN→group、ASN index、完整 groups、explorer root/overview、组/叶图块、names/adj 分桶和 manifest schemaVersion 1 的既有结构。数字 ASN 范围限制为 1..2^32-1，关系仅接受 CAIDA 0/-1，非法输入明确失败；旧 Python 对部分非法关系行更宽松。无向对采用首次关系行优先，保留 provider→customer 方向。snapshot 的统计和 explorer 使用同一去重规则；旧 explorer 原来因度数断言拒绝重复行，现可接受。self-loop 为一条关系、一条邻接，与 snapshot 的 Set 度数一致，directedAdjacencyEntries 为 `2 * uniqueRelationships - selfLoops`；旧 explorer 原来会拒绝这类输入。

JSON 统一 UTF-8，部分旧 Python 输出使用 Unicode 转义，解析后的字符串相同但序列化字节不同。manifest 的 gzip 估算使用 Node zlib level 6；压缩版本/字节可能不同。文件大小只统计本轮输出，排除旧 manifest 和残留 JSON；elapsedSeconds 为实测时间，不参与确定性对比。复用输出目录不会删除旧图块，发布时应使用新目录并按本轮 manifest 选取文件。来源日期读取 fetchedDate/fetchedAt；旧 sources 缺少时间戳时保留历史 `2026-09-22` fallback，维护者应为新的本地输入提供真实获取日期。

输入流复用现有 MIT bzip2 解码器及其块/CRC 校验，gzip 使用 Node zlib；图及索引仍保存在维护者进程内存中，完整 CAIDA 的时间、内存与布局吞吐没有在本迁移中测量。没有重新下载或重建全量数据。

## 固定小样本验证

标准 `pnpm test` 包含现有 MRT/查询/下载转发测试及 tests/data：固定小型 CAIDA 输入、组织与未知 ASN、关系方向、去重/self-loop、社区覆盖/连接性、modularity oracle、合并规则、BFS/图块关系守恒、输出 schema、重跑确定性，以及 mock CAIDA 下载失败/日期选择。测试不发真实外部数据请求，临时输出只在 OS 临时目录。此轮测试在 GitHub 通用 CI 执行。

测试 bzip2 编码采用 compressjs 1.0.3（GPL-2.0-or-later），仅在开发测试依赖中使用，不引入浏览器/Worker bundle；gzip 编码使用 node:zlib。原有 1.1 MB 多块和拼接流仍由独立的现有浏览器解码器验证原始字节与最终 CRC，不再称为与 Python 压缩字节一致。

新增依赖与基线的完整审计归因、压缩替代取舍和剩余既有升级范围见 [依赖归因](dependency-attribution.md)。没有新增已报告告警不等于整个项目的安全验收；强制审计仍失败。
