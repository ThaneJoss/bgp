#!/usr/bin/env node
// Cross-language integration: only generated documentation-range fixtures, no network.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { handleRequest, parseIp, formatAddress } from '../../workers/bgp/src/index.mjs';

await mkdir('_bgp', { recursive: true });
const temp = await mkdtemp(resolve('_bgp/e2e-'));
const snapshot = '20000101T000000Z';
const primary = { asn: 64500, address: '192.0.2.1' };
const secondary = { asn: 64501, address: '2001:db8::ff' };
const rows = [];
const cases = [];
const integer = text => parseIp(text).bytes.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
function address(n, family) {
  const bytes = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) { bytes[i] = Number(n & 255n); n >>= 8n; }
  return formatAddress(bytes, family);
}
function route(prefix, path, unsupported = false, peer = primary) {
  const [ip, length] = prefix.split('/');
  const family = ip.includes(':') ? 6 : 4;
  const start = integer(ip);
  const end = start + (1n << BigInt((family === 4 ? 32 : 128) - Number(length)));
  rows.push({ prefix, peer, path, unsupported, start, end, family, length: Number(length) });
}
route('0.0.0.0/0', [64500, 64510]);
route('10.0.0.0/8', [64500, 64500, 4200000000]);
route('2001:db8::/32', [64500, 64520]);
route('::/0', [64501, 64530], false, secondary);
route('172.16.0.0/24', [64500, 64599]);
route('172.16.1.0/24', [64500, 64599]);
route('2001:db8:1::/128', [64500, 64599]);
route('2001:db8:1::1/128', [64500, 64599]);
cases.push('172.16.0.1', '172.16.1.1', '2001:db8:1::', '2001:db8:1::1');
// More than 1024 change records force real sparse-index page boundaries.
for (let i = 0; i < 1100; i++) {
  const n = integer('10.0.0.0') + BigInt(i * 2);
  route(`${address(n, 4)}/32`, [64500, 4200000001 + (i % 11)], i % 101 === 0);
  if (i % 17 === 0) for (const delta of [-1n, 0n, 1n]) cases.push(address(n + delta, 4));
}
for (let i = 0; i < 700; i++) {
  const n = integer('2001:db8::') + BigInt(i * 2);
  route(`${address(n, 6)}/128`, [64500, 64540 + (i % 13)], i % 97 === 0);
  if (i % 19 === 0) for (const delta of [-1n, 0n, 1n]) cases.push(address(n + delta, 6));
}
cases.push('0.0.0.0', '255.255.255.255', '9.255.255.255', '11.0.0.0', '::', '2001:db9::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
const ordered = rows.filter(r => r.peer === primary).sort((a, b) => b.length - a.length);
const oracle = ip => {
  const n = integer(ip); const family = ip.includes(':') ? 6 : 4;
  const winner = ordered.find(row => row.family === family && row.start <= n && row.end > n);
  return winner ? { status: winner.unsupported ? 'unsupported_path' : 'ok', winner } : { status: 'not_observed' };
};
try {
  const input = join(temp, 'fixture.jsonl'); const config = join(temp, 'config.json'); const out = join(temp, 'snapshot');
  await writeFile(input, rows.map(({ prefix, path, unsupported, peer }) => JSON.stringify({ prefix, path, unsupported, peer })).reverse().join('\n') + '\n');
  await writeFile(config, JSON.stringify({ id: 'synthetic-only', location: 'Generated fixture', sourceUrl: 'https://example.invalid/fixtures', selection: { maxPeers: 2, preferredAsns: [64500], minPrefixes: { 4: 1, 6: 1 }, requireFamilies: [4, 6] } }));
  execFileSync(process.env.PYTHON || 'python3', ['scripts/bgp/build_snapshot.py', '--input', input, '--output', out, '--collector-config', config, '--snapshot-id', snapshot, '--data-time', '2000-01-01T00:00:00Z'], { cwd: resolve('.'), stdio: 'pipe' });
  execFileSync(process.env.PYTHON || 'python3', ['scripts/bgp/validate_snapshot.py', '--directory', out, '--config', config], { cwd: resolve('.'), stdio: 'pipe' });
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert(manifest.peers[0].families['4'].indexCount > 1);
  assert(manifest.peers[0].families['6'].indexCount > 1);
  let reads = 0; let bytes = 0; const keys = [];
  const bucket = { async get(key, options) {
    reads++; keys.push(key);
    const relative = key === 'latest.json' ? key : key.startsWith(`snapshots/${snapshot}/`) ? key.slice(`snapshots/${snapshot}/`.length) : null;
    if (!relative || relative.includes('..')) throw Error('Unexpected R2 object key');
    const file = await readFile(join(out, relative));
    const part = options?.range ? file.subarray(options.range.offset, options.range.offset + options.range.length) : file;
    bytes += part.byteLength;
    return { size: file.length, body: new Response(part).body };
  } };
  for (const ip of cases) {
    reads = bytes = 0;
    const response = await handleRequest(new Request(`https://fixture.invalid/api/bgp/path?ip=${encodeURIComponent(ip)}`), { BGP_BUCKET: bucket });
    assert.equal(response.status, 200, `${ip}: ${await response.clone().text()}`);
    const result = await response.json(); const expected = oracle(ip);
    assert.equal(result.status, expected.status, ip);
    if (expected.status === 'ok') {
      assert.equal(result.routes[0].prefix, expected.winner.prefix, ip);
      assert.deepEqual(result.routes[0].path, expected.winner.path, ip);
    } else assert.deepEqual(result.routes, [], ip);
    assert(reads <= 4); assert(bytes <= 64 * 1024 + 256 * 1024 + 24576 + 1024);
  }
  reads = bytes = 0; keys.length = 0;
  const compare = await handleRequest(new Request('https://fixture.invalid/api/bgp/compare?a=10.0.0.3&b=2001:db8::3'), { BGP_BUCKET: bucket });
  assert.equal(compare.status, 200);
  const pair = await compare.json();
  assert(pair.results.every(result => result.snapshotId === snapshot && result.routes[0].peer === primary.address));
  assert.equal(keys.filter(key => key === 'latest.json').length, 1); assert(reads <= 7);
  const v6peer = manifest.peers.find(peer => peer.address === secondary.address);
  const absent = await handleRequest(new Request(`https://fixture.invalid/api/bgp/path?ip=1.1.1.1&peer=${v6peer.id}`), { BGP_BUCKET: bucket });
  assert.equal((await absent.json()).status, 'missing_family');
  console.log(JSON.stringify({ test: 'Python builder → actual Worker handler → independent LPM oracle', inputPrefixes: rows.length, checkedIPs: cases.length, compareReads: 7, networkRequests: 0, status: 'PASS' }));
} finally { await rm(temp, { recursive: true, force: true }); }
