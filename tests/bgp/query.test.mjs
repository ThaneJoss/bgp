import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, parseIp, LIMITS } from '../../workers/bgp/src/index.mjs';

const encoder = new TextEncoder();
const SNAPSHOT = '20260922T000000Z';
const PATHS = [[64500, 64501], [64500, 64502, 64502], [64500, 64510]];

function fixture({ ipv6 = true, pageSize = 2 } = {}) {
  const objects = new Map();
  const manifest = {
    schemaVersion: 1, snapshotId: SNAPSHOT, generatedAt: '2026-09-22T00:10:00Z', dataTime: '2026-09-22T00:00:00Z',
    collector: { id: 'synthetic', location: 'Test fixture only', sourceUrl: 'https://example.invalid/archive' },
    defaultPeer: 'p0', peers: [{ id: 'p0', asn: 64500, address: '192.0.2.1', label: 'Synthetic AS64500', families: {} }], files: [],
  };
  const routes = {
    4: [['0.0.0.0', 0, 0], ['10.0.0.0', 1, 8, 0], ['10.1.0.0', 1, 16, 1], ['10.2.0.0', 1, 8, 0], ['11.0.0.0', 0, 0], ['192.0.2.0', 2, 24], ['192.0.3.0', 0, 0]],
    6: [['::', 0, 0], ['2001:db8::', 1, 32, 2], ['2001:db8:1::', 1, 48, 1], ['2001:db8:2::', 1, 32, 2], ['2001:db9::', 0, 0]],
  };
  for (const family of ipv6 ? [4, 6] : [4]) {
    const rows = routes[family]; const offsets = [];
    const paths = new Uint8Array(PATHS.flat().length * 4); const pathView = new DataView(paths.buffer); let current = 0;
    for (const path of PATHS) { offsets.push(current); for (const asn of path) { pathView.setUint32(current, asn); current += 4; } }
    const records = new Uint8Array(rows.length * 24); const recordView = new DataView(records.buffer);
    for (let i = 0; i < rows.length; i++) {
      const [ip, flags, prefix, pathIndex = 0] = rows[i]; const offset = i * 24;
      records.set(parseIp(ip).bytes, offset); recordView.setUint32(offset + 16, flags === 1 ? offsets[pathIndex] : 0);
      recordView.setUint16(offset + 20, flags === 1 ? PATHS[pathIndex].length : 0); recordView.setUint8(offset + 22, prefix); recordView.setUint8(offset + 23, flags);
    }
    const indexCount = Math.ceil(rows.length / pageSize); const index = new Uint8Array(indexCount * 24); const indexView = new DataView(index.buffer);
    for (let i = 0; i < indexCount; i++) {
      index.set(records.subarray(i * pageSize * 24, i * pageSize * 24 + 16), i * 24);
      indexView.setUint32(i * 24 + 16, i * pageSize * 24); indexView.setUint16(i * 24 + 20, Math.min(pageSize, rows.length - i * pageSize));
    }
    const metadata = { intervalCount: rows.length, indexCount };
    for (const [type, bytes] of Object.entries({ index, records, paths })) {
      const key = `p0/v${family}.${type}.bin`; metadata[type] = key;
      objects.set(`snapshots/${SNAPSHOT}/${key}`, bytes); manifest.files.push({ key, bytes: bytes.length, sha256: '0'.repeat(64) });
    }
    manifest.peers[0].families[family] = metadata;
  }
  const reads = [];
  const refresh = () => objects.set('latest.json', encoder.encode(JSON.stringify(manifest)));
  refresh();
  const bucket = {
    async get(key, options) {
      const bytes = objects.get(key);
      if (!bytes) { reads.push({ key, length: 0 }); return null; }
      const range = options?.range;
      const body = range ? bytes.slice(range.offset, range.offset + range.length) : bytes.slice();
      reads.push({ key, length: body.length, range });
      return { size: bytes.length, body: new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }) };
    },
  };
  return { objects, manifest, bucket, reads, refresh };
}

async function query(data, path, options = {}) {
  const response = await handleRequest(new Request(`https://worker.example${path}`, options), { BGP_BUCKET: data.bucket, APP_ORIGIN: 'https://app.example' });
  return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
}

test('strict IP parser accepts equivalent IPv6 forms and rejects ambiguous input', () => {
  for (const ip of ['1.1.1.1', '255.255.255.255', '::', '::1', '2001:db8::1', '2001:db8:0:0:0:0:0:1', '::ffff:192.0.2.1']) assert.equal(parseIp(ip).bytes.length, 16);
  assert.equal(parseIp('2001:DB8:0:0::1').canonical, '2001:db8::1');
  for (const ip of ['', null, '1.2.3', '01.2.3.4', '256.1.1.1', ' 1.1.1.1', '1.1.1.1/32', '2001::db8::1', '::ffff:192.168.001.1', 'fe80::1%eth0', '[::1]', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7::8']) assert.throws(() => parseIp(ip), { status: 400 });
});

test('longest-prefix intervals restore the less-specific route after more-specific route ends', async () => {
  const data = fixture();
  const moreSpecific = await query(data, '/api/bgp/path?ip=10.1.2.3');
  assert.equal(moreSpecific.status, 200); assert.equal(moreSpecific.body.status, 'ok');
  assert.equal(moreSpecific.body.routes[0].prefix, '10.1.0.0/16');
  assert.deepEqual(moreSpecific.body.routes[0].path, [64500, 64502, 64502]);
  const lessSpecific = await query(data, '/api/bgp/path?ip=10.2.2.3');
  assert.equal(lessSpecific.body.routes[0].prefix, '10.0.0.0/8');
  assert.deepEqual(lessSpecific.body.routes[0].path, [64500, 64501]);
  assert.equal((await query(data, '/api/bgp/path?ip=11.0.0.1')).body.status, 'not_observed');
});

test('IPv6 uses exact 128-bit comparisons and masked canonical prefixes', async () => {
  const data = fixture();
  const result = await query(data, '/api/bgp/path?ip=2001:db8:1:ffff::abcd');
  assert.equal(result.body.routes[0].prefix, '2001:db8:1::/48');
  assert.deepEqual(result.body.routes[0].path, PATHS[1]);
  assert.equal((await query(data, '/api/bgp/path?ip=2001:db8:ffff::1')).body.routes[0].prefix, '2001:db8::/32');
  assert.equal((await query(data, '/api/bgp/path?ip=ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).body.status, 'not_observed');
});

test('missing family and non-linear paths are explicit; neither invents a route', async () => {
  const data = fixture({ ipv6: false });
  assert.equal((await query(data, '/api/bgp/path?ip=2001:db8::1')).body.status, 'missing_family');
  const result = await query(data, '/api/bgp/path?ip=192.0.2.100');
  assert.equal(result.body.status, 'unsupported_path'); assert.deepEqual(result.body.routes, []);
});

test('two IPs share one manifest and one peer; mixed-family reads stay bounded', async () => {
  const data = fixture();
  const get = data.bucket.get;
  data.bucket.get = async (key, options) => {
    const result = await get(key, options);
    if (key === 'latest.json') { data.manifest.snapshotId = 'new-version-published-concurrently'; data.refresh(); }
    return result;
  };
  const result = await query(data, '/api/bgp/compare?a=10.1.0.1&b=2001:db8:1::1');
  assert.equal(result.status, 200); assert.equal(result.body.snapshotId, SNAPSHOT);
  assert.equal(result.body.peer.id, 'p0');
  assert.ok(result.body.results.every((entry) => entry.snapshotId === SNAPSHOT && entry.routes[0].peer === '192.0.2.1'));
  assert.equal(data.reads.filter((read) => read.key === 'latest.json').length, 1);
  assert.equal(data.reads.length, 7);
  assert.ok(data.reads.reduce((sum, read) => sum + read.length, 0) <= 641024);
  for (const read of data.reads) if (read.range) assert.ok(read.length <= (read.key.endsWith('records.bin') ? 24576 : 1024));
});

test('same-family compare reuses index fetch within request', async () => {
  const data = fixture();
  assert.equal((await query(data, '/api/bgp/compare?a=10.1.2.3&b=10.2.2.3')).status, 200);
  assert.equal(data.reads.length, 6);
  assert.equal(data.reads.filter((read) => read.key.endsWith('index.bin')).length, 1);
});

test('invalid requests fail before any R2 read, and unknown peers are 404', async () => {
  for (const path of ['/api/bgp/path?ip=bad', '/api/bgp/compare?a=1.1.1.1', '/api/bgp/path?ip=1.1.1.1&ip=8.8.8.8', '/api/bgp/path?ip=1.1.1.1&peer=../p0', '/api/bgp/path?ip=1.1.1.1&url=https://example.org']) {
    const data = fixture(); assert.equal((await query(data, path)).status, 400); assert.equal(data.reads.length, 0);
  }
  assert.equal((await query(fixture(), '/api/bgp/path?ip=1.1.1.1&peer=unknown')).status, 404);
});

test('metadata endpoint excludes file inventory; CORS is restricted', async () => {
  const data = fixture();
  const result = await query(data, '/api/bgp/manifest', { headers: { Origin: 'https://app.example' } });
  assert.equal(result.status, 200); assert.equal(result.headers.get('Access-Control-Allow-Origin'), 'https://app.example');
  assert.equal(result.body.files, undefined); assert.deepEqual(result.body.peers[0].families, [4, 6]);
  assert.equal((await query(data, '/api/bgp/manifest', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await query(data, '/api/bgp/manifest', { method: 'OPTIONS', headers: { Origin: 'https://app.example' } })).status, 204);
});

test('malformed manifests and missing data return 503, never fabricated paths', async () => {
  const cases = [
    (data) => { data.manifest.snapshotId = '../escape'; data.refresh(); },
    (data) => { data.manifest.peers[0].families[4].records = '../../secret.records.bin'; data.refresh(); },
    (data) => { data.manifest.peers[0].families[4].indexCount = 1; data.refresh(); },
    (data) => { data.objects.set('latest.json', new Uint8Array(LIMITS.manifest + 1)); },
    (data) => { data.objects.delete(`snapshots/${SNAPSHOT}/p0/v4.index.bin`); },
  ];
  for (const change of cases) { const data = fixture(); change(data); const result = await query(data, '/api/bgp/path?ip=10.1.2.3'); assert.equal(result.status, 503); assert.equal(result.body.routes, undefined); }
});

test('builder auxiliary files are accepted only by fixed name and never queried', async () => {
  const data = fixture();
  for (const key of ['normalized.jsonl.gz', 'diff.jsonl.gz', 'selection.json']) data.manifest.files.push({ key, bytes: 4096, sha256: '0'.repeat(64) });
  data.refresh();
  assert.equal((await query(data, '/api/bgp/path?ip=10.1.2.3')).status, 200);
  assert.ok(data.reads.every((read) => read.key === 'latest.json' || read.key.endsWith('.bin')));
  data.manifest.files.at(-1).key = 'unexpected.json'; data.refresh();
  assert.equal((await query(data, '/api/bgp/path?ip=10.1.2.3')).status, 503);
  data.manifest.files.at(-1).key = 'selection.json'; data.manifest.files.at(-1).bytes = 1024 ** 3 + 1; data.refresh();
  assert.equal((await query(data, '/api/bgp/path?ip=10.1.2.3')).status, 503);
});

test('corrupt index offsets, record paths, flags, and truncated bodies are rejected', async () => {
  const cases = [
    (data) => new DataView(data.objects.get(`snapshots/${SNAPSHOT}/p0/v4.index.bin`).buffer).setUint32(16, 24),
    (data) => new DataView(data.objects.get(`snapshots/${SNAPSHOT}/p0/v4.index.bin`).buffer).setUint16(22, 1),
    (data) => new DataView(data.objects.get(`snapshots/${SNAPSHOT}/p0/v4.records.bin`).buffer).setUint32(2 * 24 + 16, 0xfffffffc),
    (data) => new DataView(data.objects.get(`snapshots/${SNAPSHOT}/p0/v4.records.bin`).buffer).setUint16(2 * 24 + 20, 257),
    (data) => new DataView(data.objects.get(`snapshots/${SNAPSHOT}/p0/v4.records.bin`).buffer).setUint8(2 * 24 + 23, 7),
    (data) => new DataView(data.objects.get(`snapshots/${SNAPSHOT}/p0/v4.records.bin`).buffer).setUint8(2 * 24 + 22, 32),
    (data) => { const key = `snapshots/${SNAPSHOT}/p0/v4.records.bin`; data.objects.set(key, data.objects.get(key).slice(0, -1)); },
  ];
  for (const change of cases) { const data = fixture(); change(data); assert.equal((await query(data, '/api/bgp/path?ip=10.1.2.3')).status, 503); }
});

test('an upstream that ignores range cannot make the Worker buffer the full database', async () => {
  const data = fixture(); const get = data.bucket.get;
  data.bucket.get = async (key, options) => {
    if (key.endsWith('records.bin')) return { size: data.objects.get(key).length, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(24577)); controller.close(); } }) };
    return get(key, options);
  };
  assert.equal((await query(data, '/api/bgp/path?ip=10.1.2.3')).status, 503);
});
