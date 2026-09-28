import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { loadRoutingTable } from '../../lib/bgp/load.mjs';
import { bunzip, streamChunks } from '../../lib/bgp/streams.mjs';
import { decodeAttributes, RoutingTable } from '../../lib/bgp/mrt.mjs';
import { parseIP, formatIP } from '../../lib/bgp/ip.mjs';
import { defaultSnapshotDate, snapshotSource } from '../../lib/bgp/source.mjs';
import { fixture, compress, byteStream, peers, rib, attribute, path, uint, record } from './fixtures.mjs';

const v4 = '3491@123.255.90.244', v6 = '3491@2001:7fa:0:1::ca28:a0f4';
const load = bytes => loadRoutingTable(byteStream(bytes), {});

for (const encoding of ['mrt', 'bz2', 'gzip']) test(`${encoding}: streamed IPv4/IPv6 LPM, sessions, unsupported masks, prepends`, async () => {
  const raw = fixture();
  const table = await load(encoding === 'mrt' ? raw : encoding === 'gzip' ? gzipSync(raw) : compress(raw));
  assert.equal(table.metadata.peers.length, 2);
  assert.equal(table.metadata.routeCount, 6);
  assert.deepEqual(table.lookup('1.1.1.1', v4).routes[0].path, [3491, 13335]);
  assert.equal(table.lookup('1.1.1.200', v4).status, 'unsupported_path');
  assert.equal(table.lookup('8.8.8.8', v4).routes[0].prefix, '8.8.8.0/24');
  assert.equal(table.lookup('9.9.9.9', v4).routes[0].prefix, '0.0.0.0/0');
  assert.equal(table.lookup('255.255.255.255', v4).routes[0].prefix, '255.255.255.255/32');
  assert.equal(table.lookup('2001:db8::1', v6).routes[0].prefix, '2001:db8::/32');
  assert.equal(table.lookup('2001:db9::1', v6).status, 'not_observed');
  assert.equal(table.lookup('2001:db8::1', v4).status, 'missing_family');
  assert.equal(table.lookup('1.1.1.1', v6).status, 'missing_family');
  assert.throws(() => table.lookup('1.1.1.1', 'unknown'));
});

test('all unicast MRT/ADDPATH layouts and conflicting paths fail closed', async () => {
  for (const subtype of [2, 4, 6, 8, 10, 12]) {
    const family = [4, 10].includes(subtype) ? 6 : 4;
    const table = await load(Buffer.concat([peers(), rib(family === 6 ? '20010db8' : '010101', family === 6 ? 32 : 24, [3491, 13335], { subtype, family, index: family === 6 ? 1 : 0 })]));
    assert.equal(table.lookup(family === 6 ? '2001:db8::1' : '1.1.1.1', family === 6 ? v6 : v4).status, 'ok');
  }
  const table = await load(Buffer.concat([fixture(), rib('010101', 24, [3491, 6939], { subtype: 8 }), rib('010101', 24, [3491, 13335], { subtype: 8 })]));
  assert.equal(table.lookup('1.1.1.1', v4).status, 'unsupported_path');
});

test('RFC 6793 reconstruction, malformed/non-linear paths, and 256-ASN bound', () => {
  const attributes = (...parts) => Buffer.concat(parts);
  assert.deepEqual(decodeAttributes(attributes(attribute(2, path([3491, 23456])), attribute(17, path([4200000000])))), [3491, 4200000000]);
  assert.deepEqual(decodeAttributes(attributes(attribute(2, path([3491, 13335])), attribute(17, path([4200000000])))), [3491, 13335]);
  assert.equal(decodeAttributes(attributes(attribute(2, path([3491, 23456])), attribute(17, path([13335])), attribute(7, Buffer.concat([uint(3491, 4), Buffer.alloc(4)])), attribute(18, Buffer.alloc(8)))), null);
  for (const kind of [1, 3, 4]) assert.equal(decodeAttributes(attribute(2, path([3491, 13335], kind))), null);
  assert.equal(decodeAttributes(attribute(2, Buffer.from([2, 1, 0]))), null);
  assert.equal(decodeAttributes(attribute(2, path([3491, 0]))), null);
  assert.throws(() => decodeAttributes(attributes(attribute(2, path([3491])), attribute(2, path([13335])))), /重复/);
  assert.throws(() => decodeAttributes(attribute(2, Buffer.concat([path(Array(255).fill(3491)), path([13335, 15169])]))), /256/);
});

test('truncated, corrupt, unrelated and oversized files never become ready', async () => {
  const raw = fixture(), bz = compress(raw);
  for (const bytes of [raw.subarray(0, 11), raw.subarray(0, raw.length - 1), bz.subarray(0, bz.length - 5), Buffer.from('<html>error</html>'), Buffer.concat([peers(), peers()]), Buffer.concat([peers(), rib('010101', 24, [3491], { index: 7 })]), record(1, Buffer.alloc(0), 12)]) {
    await assert.rejects(() => load(bytes));
  }
  const corrupt = Buffer.from(bz); corrupt[10] ^= 1;
  await assert.rejects(() => load(corrupt));
  await assert.rejects(() => load(peers()), /没有配置/);
  await assert.rejects(() => load(Buffer.concat([peers(), uint(0, 4), uint(13, 2), uint(2, 2), uint(67108865, 4)])), /64 MiB/);
  const table = new RoutingTable({ maxRoutes: 1 });
  const peer = { id: v4 };
  table.add(peer, 4, 0n, 0, [3491]);
  assert.throws(() => table.add(peer, 4, 1n, 32, [3491]), /内存限制/);
});

test('bzip2 multi-block and concatenated streams match Python; final CRC is mandatory', async () => {
  let state = 42;
  const raw = Buffer.alloc(1100000);
  for (let i = 0; i < raw.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; raw[i] = state >>> 24; }
  const packed = compress(raw);
  const decode = async bytes => { const parts = []; for await (const chunk of bunzip(streamChunks(byteStream(bytes, 17777)))) parts.push(chunk); return Buffer.concat(parts); };
  assert.deepEqual(await decode(packed), raw);
  assert.deepEqual(await decode(Buffer.concat([compress(Buffer.from('abc')), compress(Buffer.from('xyz'))])), Buffer.from('abcxyz'));
  await assert.rejects(() => decode(packed.subarray(0, packed.length - 4)));
});

test('IP validation, IPv6 canonical form and snapshot dates', () => {
  for (const input of ['0.0.0.0', '255.255.255.255', '::', '::1', '2001:db8::1', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff']) {
    const { family, value } = parseIP(input); assert.equal(formatIP(value, family), input);
  }
  assert.equal(formatIP(parseIP('::ffff:192.0.2.1').value, 6), '::ffff:c000:201');
  for (const input of ['01.1.1.1', '256.0.0.0', '1.1.1', '1.1.1.1/24', ':::', '2001::db8::1', 'fe80::1%eth0', '[::1]', '1:2:3', '1:2:3:4:5:6:7:8:9', '']) assert.throws(() => parseIP(input));
  assert.equal(defaultSnapshotDate(new Date('2026-03-01T00:01:00Z')), '2026-02-28');
  assert.equal(snapshotSource('2026-09-27', new Date('2026-09-28')).filename, 'rib.20260927.0000.bz2');
  for (const date of ['2026-02-30', '../etc/passwd', '2100-01-01', null]) assert.throws(() => snapshotSource(date, new Date('2026-09-28')));
});
