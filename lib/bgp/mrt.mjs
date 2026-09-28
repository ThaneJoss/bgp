import { ByteReader } from './streams.mjs';
import { ALLOWED_PEERS, COLLECTOR } from './source.mjs';
import { bytesToBigInt, formatIP, parseIP, prefixKey } from './ip.mjs';

const MAX_RECORD = 64 * 1024 ** 2;
class Cursor {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  take(count) {
    if (this.pos + count > this.bytes.length) throw new Error('MRT 字段被截断。');
    const result = this.bytes.subarray(this.pos, this.pos + count);
    this.pos += count;
    return result;
  }
  uint(count) { return this.take(count).reduce((value, byte) => value * 256 + byte, 0); }
  finish() { if (this.pos !== this.bytes.length) throw new Error('MRT 记录包含多余字节。'); }
}

function segments(bytes) {
  const cursor = new Cursor(bytes), result = [];
  while (cursor.pos < bytes.length) {
    const kind = cursor.uint(1), count = cursor.uint(1);
    if (!count || ![1, 2, 3, 4].includes(kind)) throw new Error('Invalid AS_PATH');
    result.push({ kind, asns: Array.from({ length: count }, () => cursor.uint(4)) });
  }
  return result;
}

export function decodeAttributes(bytes) {
  const cursor = new Cursor(bytes), attributes = new Map();
  while (cursor.pos < bytes.length) {
    const flags = cursor.uint(1), kind = cursor.uint(1);
    const value = cursor.take(cursor.uint(flags & 16 ? 2 : 1));
    if ([2, 7, 17, 18].includes(kind)) {
      if (attributes.has(kind)) throw new Error('重复的 BGP 路径属性。');
      attributes.set(kind, value);
    }
  }
  if (!attributes.has(2)) return null;
  let path;
  try {
    const original = segments(attributes.get(2));
    if (original.some(segment => segment.kind !== 2)) return null;
    path = original.flatMap(segment => segment.asns);
    if (path.includes(23456) && attributes.has(17)) {
      let ignore = false;
      if (attributes.has(7) && attributes.has(18)) {
        if (attributes.get(7).length !== 8 || attributes.get(18).length !== 8) return null;
        ignore = new Cursor(attributes.get(7)).uint(4) !== 23456;
      }
      if (!ignore) {
        const replacement = segments(attributes.get(17));
        if (replacement.some(segment => segment.kind !== 2)) return null;
        const as4 = replacement.flatMap(segment => segment.asns);
        if (as4.length && as4.length <= path.length) path = [...path.slice(0, path.length - as4.length), ...as4];
      }
    }
  } catch { return null; }
  if (!path.length || path.includes(0) || path.includes(23456)) return null;
  if (path.length > 256) throw new Error('AS_PATH 超过 256 个 ASN。');
  return path;
}

export class RoutingTable {
  constructor({ maxRoutes = 2000000, maxPathASNs = 4000000 } = {}) {
    this.peers = [];
    this.routes = new Map();
    this.paths = [null]; // 0 = unsupported, which still masks less-specific routes.
    this.pathIds = new Map();
    this.routeCount = 0;
    this.pathASNs = 0;
    this.maxRoutes = maxRoutes;
    this.maxPathASNs = maxPathASNs;
    this.records = 0;
    this.timestamp = 0;
  }
  add(peer, family, start, length, path) {
    let byFamily = this.routes.get(peer.id);
    if (!byFamily) { byFamily = new Map(); this.routes.set(peer.id, byFamily); }
    let byLength = byFamily.get(family);
    if (!byLength) { byLength = new Map(); byFamily.set(family, byLength); }
    let prefixes = byLength.get(length);
    if (!prefixes) { prefixes = new Map(); byLength.set(length, prefixes); }
    const key = prefixKey(start, family, length);
    let id = 0;
    if (path) {
      const packed = path.join(',');
      id = this.pathIds.get(packed);
      if (id === undefined) {
        if ((this.pathASNs += path.length) > this.maxPathASNs) throw new Error('路径索引超过浏览器内存限制。');
        id = this.paths.length;
        this.paths.push(path);
        this.pathIds.set(packed, id);
      }
    }
    if (prefixes.has(key)) {
      // Conflicting ADDPATH routes cannot be represented as one linear path.
      if (prefixes.get(key) !== id) prefixes.set(key, 0);
    } else {
      if (++this.routeCount > this.maxRoutes) throw new Error('路由数量超过浏览器内存限制。');
      prefixes.set(key, id);
    }
  }
  finish(source) {
    if (!this.routeCount) throw new Error('文件中没有配置的 AS3491 HKIX session 路由。');
    this.pathIds.clear();
    const peers = this.peers.filter(peer => this.routes.has(peer.id)).map(peer => ({
      ...peer, families: [...this.routes.get(peer.id).keys()],
      prefixCounts: Object.fromEntries([...this.routes.get(peer.id)].map(([family, lengths]) => [family, [...lengths.values()].reduce((count, prefixes) => count + prefixes.size, 0)])),
    }));
    const dataTime = new Date(this.timestamp * 1000).toISOString();
    this.metadata = {
      snapshotId: source.snapshotId ?? `local-${this.timestamp}`, dataTime,
      source: source.label ?? 'RouteViews HKIX · browser', collector: COLLECTOR,
      defaultPeer: peers.find(peer => peer.families.includes(4))?.id ?? peers[0].id,
      peers, routeCount: this.routeCount,
    };
    return this;
  }
  lookup(input, peerId) {
    const { family, value } = parseIP(input);
    if (!this.metadata.peers.some(peer => peer.id === peerId)) throw new Error('请选择已有的观测视角。');
    const result = {
      ip: formatIP(value, family), fetchedAt: new Date().toISOString(),
      dataTime: this.metadata.dataTime, source: this.metadata.source, snapshotId: this.metadata.snapshotId,
      status: 'not_observed', routes: [],
    };
    const lengths = this.routes.get(peerId)?.get(family);
    if (!lengths) return { ...result, status: 'missing_family' };
    for (let length = family === 4 ? 32 : 128; length >= 0; length--) {
      const key = prefixKey(value, family, length);
      const id = lengths.get(length)?.get(key);
      if (id === undefined) continue;
      if (!id) return { ...result, status: 'unsupported_path' };
      const path = this.paths[id];
      return { ...result, status: 'ok', routes: [{
        rrc: COLLECTOR.id, location: COLLECTOR.location, peer: peerId,
        prefix: `${formatIP(family === 4 ? BigInt(key) : BigInt(`0x${key}`), family)}/${length}`,
        path: path.filter((asn, index) => index === 0 || asn !== path[index - 1]),
        observedAt: this.metadata.dataTime,
      }] };
    }
    return result;
  }
}

export async function parseMRT(chunks, source = {}, onProgress = () => {}) {
  const input = new ByteReader(chunks), table = new RoutingTable();
  let peers = null;
  try {
    while (await input.ensure(1)) {
      const header = new Cursor(await input.take(12));
      const timestamp = header.uint(4), type = header.uint(2), subtype = header.uint(2), size = header.uint(4);
      if (type !== 13) throw new Error(`仅支持 MRT TABLE_DUMP_V2，收到类型 ${type}。`);
      if (size > MAX_RECORD) throw new Error('MRT 记录超过 64 MiB 限制。');
      const cursor = new Cursor(await input.take(size));
      if (!table.records) table.timestamp = timestamp;
      table.records++;
      if (subtype === 1) {
        if (peers) throw new Error('不支持同一文件包含多个 Peer 表。');
        cursor.take(4);
        cursor.take(cursor.uint(2));
        peers = [];
        const sessions = new Set();
        const count = cursor.uint(2);
        for (let i = 0; i < count; i++) {
          const kind = cursor.uint(1);
          if (kind & ~3) throw new Error('未知的 Peer flags。');
          cursor.take(4);
          const family = kind & 1 ? 6 : 4;
          const address = formatIP(bytesToBigInt(cursor.take(family === 6 ? 16 : 4)), family);
          const asn = cursor.uint(kind & 2 ? 4 : 2), id = `${asn}@${address}`;
          if (sessions.has(id)) throw new Error('重复的 Peer session。');
          sessions.add(id);
          const peer = { id, asn, address };
          const selected = ALLOWED_PEERS.some(allowed => allowed.asn === asn && allowed.address === address);
          peers.push(selected ? peer : null);
          if (selected) table.peers.push(peer);
        }
        cursor.finish();
        continue;
      }
      if (!peers) throw new Error('RIB 出现在 Peer 表之前。');
      if ([3, 5, 9, 11].includes(subtype)) continue; // multicast is outside scope
      if (![2, 4, 6, 8, 10, 12].includes(subtype)) throw new Error(`不支持 MRT 子类型 ${subtype}。`);
      cursor.take(4);
      let family;
      if ([6, 12].includes(subtype)) {
        const afi = cursor.uint(2), safi = cursor.uint(1);
        if (![1, 2].includes(afi) || safi !== 1) throw new Error('不支持该 RIB_GENERIC 地址族。');
        family = afi === 1 ? 4 : 6;
        if (subtype === 12) cursor.take(4);
      } else family = [2, 8].includes(subtype) ? 4 : 6;
      const width = family === 4 ? 32 : 128, length = cursor.uint(1);
      if (length > width) throw new Error('无效的 IP 前缀长度。');
      const raw = cursor.take(Math.ceil(length / 8));
      const start = bytesToBigInt(raw) << BigInt(width - raw.length * 8);
      const count = cursor.uint(2);
      for (let i = 0; i < count; i++) {
        const index = cursor.uint(2);
        cursor.take(4);
        if ([8, 10].includes(subtype)) cursor.take(4);
        const attributes = cursor.take(cursor.uint(2));
        if (index >= peers.length) throw new Error('RIB 引用了未知 Peer。');
        const peer = peers[index];
        if (peer) table.add(peer, family, start, length, decodeAttributes(attributes));
      }
      cursor.finish();
      if (table.records % 4096 === 0) onProgress({ records: table.records, routes: table.routeCount });
    }
    if (!peers) throw new Error('文件中没有 MRT Peer 表。');
    if (source.dataTime && new Date(table.timestamp * 1000).toISOString().slice(0, 10) !== source.dataTime.slice(0, 10)) throw new Error('文件中的日期与请求的快照日期不一致。');
    onProgress({ records: table.records, routes: table.routeCount });
    return table.finish(source);
  } finally { await input.close(); }
}
