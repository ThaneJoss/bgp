// Independent, bounded BGP query Worker. No framework or upstream API requests.
export const LIMITS = Object.freeze({ manifest: 64 * 1024, index: 256 * 1024, pageRecords: 1024, record: 24, pathASNs: 256, peers: 5 });
const SOURCE = 'offline-bgp-snapshot';
const decoder = new TextDecoder('utf-8', { fatal: true });

export class QueryError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const corrupt = () => { throw new QueryError(503, 'Snapshot unavailable or invalid'); };
const uint = (n, max = 0xffffffff) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const plain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const boundedString = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max;
const validKey = (s) => boundedString(s, 180) && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:index|records|paths)\.bin$/.test(s);
const AUXILIARY_KEYS = new Set(['normalized.jsonl.gz', 'diff.jsonl.gz', 'selection.json']);

function ipv4Bytes(input) {
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(input)) return null;
  const octets = input.split('.').map(Number);
  return octets.every((x) => x <= 255) ? octets : null;
}

/** Strict bare IP parser; rejects URLs, CIDRs, zones, whitespace and ambiguous IPv4. */
export function parseIp(input) {
  if (!boundedString(input, 45) || input.trim() !== input) throw new QueryError(400, 'Expected a bare IPv4 or IPv6 address');
  const bytes = new Uint8Array(16);
  if (!input.includes(':')) {
    const octets = ipv4Bytes(input);
    if (!octets) throw new QueryError(400, 'Invalid IPv4 address');
    bytes.set(octets, 12);
    return { family: 4, bytes, canonical: octets.join('.') };
  }
  let text = input.toLowerCase();
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    const octets = ipv4Bytes(text.slice(lastColon + 1));
    if (!octets) throw new QueryError(400, 'Invalid IPv6 address');
    text = `${text.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) throw new QueryError(400, 'Invalid IPv6 address');
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  if (![...left, ...right].every((s) => /^[0-9a-f]{1,4}$/.test(s))) throw new QueryError(400, 'Invalid IPv6 address');
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) throw new QueryError(400, 'Invalid IPv6 address');
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  for (let i = 0; i < 8; i++) { const n = parseInt(groups[i], 16); bytes[i * 2] = n >>> 8; bytes[i * 2 + 1] = n & 255; }
  return { family: 6, bytes, canonical: formatAddress(bytes, 6) };
}

export function formatAddress(bytes, family) {
  if (family === 4) return Array.from(bytes.subarray(12)).join('.');
  const groups = Array.from({ length: 8 }, (_, i) => (bytes[i * 2] << 8) | bytes[i * 2 + 1]);
  let bestStart = -1; let bestLength = 1;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    const start = i;
    while (i < 8 && groups[i] === 0) i++;
    if (i - start > bestLength) { bestStart = start; bestLength = i - start; }
  }
  if (bestStart < 0) return groups.map((g) => g.toString(16)).join(':');
  return `${groups.slice(0, bestStart).map((g) => g.toString(16)).join(':')}::${groups.slice(bestStart + bestLength).map((g) => g.toString(16)).join(':')}`;
}

function compareAt(view, offset, target) {
  for (let i = 0; i < 16; i++) { const difference = view.getUint8(offset + i) - target[i]; if (difference) return difference; }
  return 0;
}
function compareRecords(view, a, b) {
  for (let i = 0; i < 16; i++) { const difference = view.getUint8(a + i) - view.getUint8(b + i); if (difference) return difference; }
  return 0;
}

/** Returns the last record whose 16-byte address is <= target. */
export function findFloor(view, count, target, stride = LIMITS.record) {
  let low = 0; let high = count;
  while (low < high) { const mid = (low + high) >>> 1; if (compareAt(view, mid * stride, target) <= 0) low = mid + 1; else high = mid; }
  return low - 1;
}

/** Validate untrusted metadata before constructing any object key or range. */
export function validateManifest(raw) {
  if (!plain(raw) || raw.schemaVersion !== 1 || !boundedString(raw.snapshotId, 64) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(raw.snapshotId)) corrupt();
  if (!boundedString(raw.generatedAt, 40) || !Number.isFinite(Date.parse(raw.generatedAt)) || !boundedString(raw.dataTime, 40) || !Number.isFinite(Date.parse(raw.dataTime))) corrupt();
  if (!plain(raw.collector) || !boundedString(raw.collector.id, 64) || !boundedString(raw.collector.location, 160) || !boundedString(raw.collector.sourceUrl, 512)) corrupt();
  try { const source = new URL(raw.collector.sourceUrl); if (source.protocol !== 'https:' || source.username || source.password) corrupt(); } catch { corrupt(); }
  if (!Array.isArray(raw.peers) || raw.peers.length < 1 || raw.peers.length > LIMITS.peers || !Array.isArray(raw.files) || raw.files.length > LIMITS.peers * 6 + AUXILIARY_KEYS.size) corrupt();
  const files = new Map();
  const fileKeys = new Set();
  for (const file of raw.files) {
    if (!plain(file) || (!validKey(file.key) && !AUXILIARY_KEYS.has(file.key)) || fileKeys.has(file.key) || !uint(file.bytes) || !/^[a-f0-9]{64}$/.test(file.sha256)) corrupt();
    fileKeys.add(file.key);
    if (AUXILIARY_KEYS.has(file.key)) { if (file.bytes > 1024 ** 3) corrupt(); }
    else files.set(file.key, file);
  }
  const ids = new Set();
  for (const peer of raw.peers) {
    if (!plain(peer) || !boundedString(peer.id, 64) || !/^[A-Za-z0-9_-]+$/.test(peer.id) || ids.has(peer.id) || !uint(peer.asn) || peer.asn === 0 || !boundedString(peer.label, 160) || !plain(peer.families)) corrupt();
    try { parseIp(peer.address); } catch { corrupt(); }
    ids.add(peer.id);
    const entries = Object.entries(peer.families);
    if (entries.length < 1 || entries.length > 2) corrupt();
    for (const [family, item] of entries) {
      if (!['4', '6'].includes(family) || !plain(item) || !uint(item.intervalCount) || item.intervalCount < 1 || !uint(item.indexCount) || item.indexCount < 1 || item.indexCount > item.intervalCount) corrupt();
      if (item.intervalCount > item.indexCount * LIMITS.pageRecords || item.indexCount * 24 > LIMITS.index || item.intervalCount * 24 > 0xffffffff) corrupt();
      if (![item.index, item.records, item.paths].every(validKey) || new Set([item.index, item.records, item.paths]).size !== 3) corrupt();
      const index = files.get(item.index); const records = files.get(item.records); const paths = files.get(item.paths);
      if (!index || !records || !paths || index.bytes !== item.indexCount * 24 || records.bytes !== item.intervalCount * 24 || paths.bytes % 4 !== 0) corrupt();
    }
  }
  if (!ids.has(raw.defaultPeer)) corrupt();
  return { ...raw, fileMap: files };
}

// Even an ignored Range must not cause a whole routing database to be buffered.
async function readBody(object, maximum, exact) {
  let bytes;
  if (object.body?.getReader) {
    const reader = object.body.getReader();
    const chunks = []; let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > maximum) { await reader.cancel(); corrupt(); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    if (exact !== undefined && total !== exact) corrupt();
    if (chunks.length === 1) return chunks[0];
    bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  } else {
    // Useful for test adapters. R2 production objects always expose body streams.
    if (!uint(object.size) || object.size > maximum) corrupt();
    bytes = new Uint8Array(await object.arrayBuffer());
  }
  if (bytes.byteLength > maximum || (exact !== undefined && bytes.byteLength !== exact)) corrupt();
  return bytes;
}

async function getManifest(bucket) {
  const object = await bucket.get('latest.json');
  if (!object || !uint(object.size) || object.size < 2 || object.size > LIMITS.manifest) { await object?.body?.cancel?.(); corrupt(); }
  const bytes = await readBody(object, LIMITS.manifest, object.size);
  try { return validateManifest(JSON.parse(decoder.decode(bytes))); } catch { corrupt(); }
}

async function getBytes(bucket, manifest, key, range, maximum) {
  const file = manifest.fileMap.get(key);
  if (!file || !validKey(key)) corrupt();
  if (range && (!uint(range.offset) || !uint(range.length) || range.length < 1 || range.offset + range.length > file.bytes || range.length > maximum)) corrupt();
  const object = await bucket.get(`snapshots/${manifest.snapshotId}/${key}`, range ? { range } : undefined);
  if (!object || object.size !== file.bytes) { await object?.body?.cancel?.(); corrupt(); }
  return readBody(object, maximum, range?.length ?? file.bytes);
}

function validateIndex(bytes, family, metadata) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let recordCount = 0;
  for (let i = 0; i < metadata.indexCount; i++) {
    const offset = i * 24; const count = view.getUint16(offset + 20);
    if (count < 1 || count > LIMITS.pageRecords || view.getUint16(offset + 22) !== 0 || view.getUint32(offset + 16) !== recordCount * 24) corrupt();
    if (i === 0 && compareAt(view, offset, new Uint8Array(16)) !== 0) corrupt();
    if (i > 0 && compareRecords(view, offset - 24, offset) >= 0) corrupt();
    if (family === 4 && (view.getUint32(offset) || view.getUint32(offset + 4) || view.getUint32(offset + 8))) corrupt();
    recordCount += count;
  }
  if (recordCount !== metadata.intervalCount) corrupt();
  return view;
}

function validatePage(bytes, family, pathsSize, index, indexPosition) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.byteLength / 24;
  for (let i = 0; i < count; i++) {
    const offset = i * 24; const pathOffset = view.getUint32(offset + 16); const length = view.getUint16(offset + 20); const prefix = view.getUint8(offset + 22); const flags = view.getUint8(offset + 23);
    if (flags > 2 || prefix > (family === 4 ? 32 : 128) || length > LIMITS.pathASNs || pathOffset % 4 !== 0 || pathOffset + length * 4 > pathsSize) corrupt();
    if ((flags === 0 || flags === 2) && (length !== 0 || pathOffset !== 0)) corrupt();
    if (flags === 1 && length === 0) corrupt();
    if (i > 0 && compareRecords(view, offset - 24, offset) >= 0) corrupt();
    if (family === 4 && (view.getUint32(offset) || view.getUint32(offset + 4) || view.getUint32(offset + 8))) corrupt();
  }
  const first = bytes.subarray(0, 16);
  if (compareAt(index, indexPosition * 24, first) !== 0) corrupt();
  if ((indexPosition + 1) * 24 < index.byteLength) {
    const last = bytes.subarray((count - 1) * 24, (count - 1) * 24 + 16);
    if (compareAt(index, (indexPosition + 1) * 24, last) <= 0) corrupt();
  }
  return view;
}

function prefixFor(ip, length) {
  const bytes = ip.bytes.slice(); const bits = length + (ip.family === 4 ? 96 : 0);
  for (let i = 0; i < 16; i++) { const keep = Math.max(0, Math.min(8, bits - i * 8)); bytes[i] &= keep === 0 ? 0 : (0xff << (8 - keep)) & 0xff; }
  return `${formatAddress(bytes, ip.family)}/${length}`;
}

export async function lookupIp(bucket, manifest, peer, ip, { indexCache = new Map(), fetchedAt = new Date().toISOString() } = {}) {
  const result = { ip: ip.canonical, fetchedAt, dataTime: manifest.dataTime, source: SOURCE, snapshotId: manifest.snapshotId, status: 'not_observed', routes: [] };
  const metadata = peer.families[String(ip.family)];
  if (!metadata) return { ...result, status: 'missing_family' };
  const cacheKey = `${manifest.snapshotId}/${metadata.index}`;
  if (!indexCache.has(cacheKey)) indexCache.set(cacheKey, getBytes(bucket, manifest, metadata.index, undefined, LIMITS.index).then((bytes) => validateIndex(bytes, ip.family, metadata)));
  const index = await indexCache.get(cacheKey);
  const pagePosition = findFloor(index, metadata.indexCount, ip.bytes);
  if (pagePosition < 0) corrupt();
  const offset = index.getUint32(pagePosition * 24 + 16); const count = index.getUint16(pagePosition * 24 + 20);
  const bytes = await getBytes(bucket, manifest, metadata.records, { offset, length: count * 24 }, LIMITS.pageRecords * 24);
  const page = validatePage(bytes, ip.family, manifest.fileMap.get(metadata.paths).bytes, index, pagePosition);
  const position = findFloor(page, count, ip.bytes);
  if (position < 0) corrupt();
  const record = position * 24; const flags = page.getUint8(record + 23);
  if (flags === 0) return result;
  // An interval must remain inside the original winning prefix. Its start can
  // be inside that prefix after a more-specific route's interval has ended.
  const prefixBits = page.getUint8(record + 22) + (ip.family === 4 ? 96 : 0);
  for (let i = 0; i < Math.ceil(prefixBits / 8); i++) {
    const mask = (0xff << Math.max(0, 8 - (prefixBits - i * 8))) & 0xff;
    if ((page.getUint8(record + i) & mask) !== (ip.bytes[i] & mask)) corrupt();
  }
  if (flags === 2) return { ...result, status: 'unsupported_path' };
  const pathLength = page.getUint16(record + 20);
  const pathBytes = await getBytes(bucket, manifest, metadata.paths, { offset: page.getUint32(record + 16), length: pathLength * 4 }, LIMITS.pathASNs * 4);
  const pathView = new DataView(pathBytes.buffer, pathBytes.byteOffset, pathBytes.byteLength);
  const path = Array.from({ length: pathLength }, (_, i) => pathView.getUint32(i * 4));
  if (path.some((asn) => asn === 0)) corrupt();
  return { ...result, status: 'ok', routes: [{ rrc: manifest.collector.id, location: manifest.collector.location, peer: peer.address, prefix: prefixFor(ip, page.getUint8(record + 22)), path, observedAt: manifest.dataTime }] };
}

function publicPeer(peer) { return { id: peer.id, asn: peer.asn, address: peer.address, label: peer.label, families: Object.keys(peer.families).map(Number) }; }
function publicManifest(manifest) { return { schemaVersion: 1, snapshotId: manifest.snapshotId, generatedAt: manifest.generatedAt, dataTime: manifest.dataTime, source: SOURCE, collector: manifest.collector, defaultPeer: manifest.defaultPeer, peers: manifest.peers.map(publicPeer) }; }

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin && origin !== env.APP_ORIGIN) return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers });
  if (origin && origin === env.APP_ORIGIN) headers['Access-Control-Allow-Origin'] = origin;
  const send = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  try {
    if (!['/api/bgp/path', '/api/bgp/compare', '/api/bgp/manifest'].includes(url.pathname)) return send({ error: 'Not found' }, 404);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' } });
    if (request.method !== 'GET') return send({ error: 'Method not allowed' }, 405);
    if (url.search.length > 512) throw new QueryError(400, 'Query too long');
    const allowed = url.pathname.endsWith('/compare') ? ['a', 'b', 'peer'] : url.pathname.endsWith('/path') ? ['ip', 'peer'] : [];
    for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new QueryError(400, 'Unexpected or repeated query parameter');
    const ips = url.pathname.endsWith('/compare') ? [parseIp(url.searchParams.get('a')), parseIp(url.searchParams.get('b'))] : url.pathname.endsWith('/path') ? [parseIp(url.searchParams.get('ip'))] : [];
    const requestedPeer = url.searchParams.get('peer');
    if (requestedPeer !== null && (!boundedString(requestedPeer, 64) || !/^[A-Za-z0-9_-]+$/.test(requestedPeer))) throw new QueryError(400, 'Invalid peer');
    if (!env.BGP_BUCKET?.get) corrupt();
    const manifest = await getManifest(env.BGP_BUCKET);
    if (ips.length === 0) return send(publicManifest(manifest));
    const peer = manifest.peers.find((item) => item.id === (requestedPeer ?? manifest.defaultPeer));
    if (!peer) throw new QueryError(404, 'Peer not found in snapshot');
    const options = { indexCache: new Map(), fetchedAt: new Date().toISOString() };
    const results = await Promise.all(ips.map((ip) => lookupIp(env.BGP_BUCKET, manifest, peer, ip, options)));
    if (ips.length === 1) return send(results[0]);
    return send({ snapshotId: manifest.snapshotId, dataTime: manifest.dataTime, source: SOURCE, collector: manifest.collector, peer: publicPeer(peer), results });
  } catch (error) {
    return send({ error: error instanceof QueryError ? error.message : 'Snapshot unavailable or invalid' }, error instanceof QueryError ? error.status : 503);
  }
}

export default { fetch: handleRequest };
