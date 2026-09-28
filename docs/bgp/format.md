# 浏览器数据格式与查询

输入为 RouteViews HKIX MRT TABLE_DUMP_V2。压缩类型由文件魔数检测，支持 bzip2、gzip 或原始 MRT；本地导入不会上传文件。

解码器按块验证 bzip2 CRC，解析器按 MRT 的 12 字节头和记录长度读取，拒绝截断、未知类型、重复 Peer 表及越界字段。支持 IPv4/IPv6 unicast、RIB_GENERIC、相应 ADDPATH；multicast 不纳入索引。

仅保存配置的两个 AS3491 ASN/address session。索引是 Worker 内的 `Map<peer, Map<family, Map<prefixLength, Map<prefix, pathId>>>>`，IPv4 key 为精确整数，IPv6 地址运算使用 BigInt、索引 key 使用十六进制字符串以避免 V8 BigInt 哈希冲突。路径去重；查询从最长前缀向 /0 查找，最多检查 33 或 129 个前缀长度。

路径状态为 `ok`、`not_observed`、`missing_family` 或 `unsupported_path`。非线性 AS_PATH 和冲突 ADDPATH 保留遮盖作用；只有连续重复的 ASN 在绘图返回值中合并。TABLE_DUMP_V2 的 AS_PATH 使用四字节 ASN；AS4_PATH 按 RFC 6793 在含 AS_TRANS 时重建。

Worker 从完整输入构建候选索引，通过后才替换当前 Worker。失败/取消终止候选 Worker，旧索引不变。索引不写入 IndexedDB、localStorage、服务器或 CI 产物。

输入上限：压缩 1 GiB，解压 8 GiB，MRT 记录 64 MiB，bzip2 输出块 64 MiB，路由 200 万，去重路径累计 400 万 ASN，单路径 256 ASN。超过上限明确报错。
