import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fetchCaida, latestFilename } from '../../scripts/data/fetch_caida.mjs';
import { readLines, relationshipRow, seededRandom } from '../../scripts/data/data-utils.mjs';
import { compress } from '../bgp/fixtures.mjs';
import { readJson, temporaryDirectory } from './fixtures.mjs';

const bases = {
  relationships: 'https://data.caida.org/datasets/as-relationships/serial-1/',
  organizations: 'https://data.caida.org/datasets/as-organizations/',
};
const files = { relationships: '20261001.as-rel.txt.bz2', organizations: '20261001.as-org2info.txt.gz' };
const payloads = { relationships: compress(Buffer.from('1|2|-1\n')), organizations: compress(Buffer.from('# test\n'), 'gzip') };

function mockFetch(calls, fail) {
  return async (url, options) => {
    calls.push(url);
    assert.equal(new URL(url).hostname, 'data.caida.org');
    assert.equal(options.headers['User-Agent'], 'Mozilla/5.0');
    assert(options.signal instanceof AbortSignal);
    for (const [key, base] of Object.entries(bases)) {
      if (url === base) {
        const suffix = key === 'relationships' ? '.as-rel.txt.bz2' : '.as-org2info.txt.gz';
        return new Response(`<a href="20261101${suffix}">future</a> ${files[key]} 20260901${suffix} ${files[key]}`);
      }
      if (url === base + files[key]) {
        return new Response(fail === key ? 'unavailable' : payloads[key], { status: fail === key ? 503 : 200 });
      }
    }
    throw new Error(`Unexpected mock request: ${url}`); // No request reaches the network.
  };
}

test('fetch uses dated CAIDA listings and publishes complete source metadata', async t => {
  const dataDir = await temporaryDirectory(t), calls = [];
  const now = new Date('2026-10-13T12:34:56.000Z');
  const result = await fetchCaida({ dataDir, now, fetchImpl: mockFetch(calls) });
  assert.deepEqual(calls.sort(), [...Object.values(bases), ...Object.entries(bases).map(([key, base]) => base + files[key])].sort());
  assert.deepEqual(await readJson(join(dataDir, 'sources.json')), result);
  for (const [key, metadata] of Object.entries(result)) {
    assert.deepEqual(metadata, {
      filename: files[key], url: bases[key] + files[key], snapshotDate: '2026-10-01',
      bytes: payloads[key].length, fetchedAt: now.toISOString(), fetchedDate: '2026-10-13',
    });
    assert.deepEqual(await readFile(join(dataDir, metadata.filename)), payloads[key]);
  }
  assert(!(await readdir(dataDir)).some(name => name.endsWith('.part')));
  assert.equal(latestFilename('20261201.as-rel.txt.bz2 20261001.as-rel.txt.bz2', /\d{8}\.as-rel\.txt\.bz2/g, '20261013'), files.relationships);
  assert.throws(() => latestFilename('20261201.as-rel.txt.bz2', /\d{8}\.as-rel\.txt\.bz2/g, '20261013'), /no eligible snapshot/);
});

test('a failed download neither publishes partial sources nor replaces an existing manifest', async t => {
  for (const existing of [false, true]) {
    const dataDir = await temporaryDirectory(t), calls = [];
    const previous = '{"previous":"snapshot"}\n';
    if (existing) await writeFile(join(dataDir, 'sources.json'), previous);
    await assert.rejects(fetchCaida({ dataDir, now: new Date('2026-10-13T00:00:00Z'), fetchImpl: mockFetch(calls, 'organizations') }), /HTTP 503/);
    assert.equal(calls.length, 4); // Both tasks settle before the failure returns.
    if (existing) assert.equal(await readFile(join(dataDir, 'sources.json'), 'utf8'), previous);
    else await assert.rejects(readFile(join(dataDir, 'sources.json')), { code: 'ENOENT' });
    assert(!(await readdir(dataDir)).some(name => name.endsWith('.part')));
  }
});

test('Node text streaming handles UTF-8, CRLF, final lines, and compressed formats', async t => {
  const dataDir = await temporaryDirectory(t);
  const input = Buffer.from('α|é\r\n\r\nlast');
  for (const [extension, bytes] of [['txt', input], ['bz2', compress(input)], ['gz', compress(input, 'gzip')]]) {
    const path = join(dataDir, `lines.${extension}`);
    await writeFile(path, bytes);
    const lines = [];
    for await (const line of readLines(path)) lines.push(line);
    assert.deepEqual(lines, ['α|é', '', 'last']);
  }
  assert.deepEqual(relationshipRow('4294967295|1|-1|extra'), [4294967295, 1, -1]);
  for (const row of ['0|1|0', '4294967296|1|0', '1|x|0', '1|2|1', '1|2', '-1|2|0']) {
    assert.throws(() => relationshipRow(row), /Invalid/);
  }
  const first = seededRandom(42), second = seededRandom(42);
  const values = Array.from({ length: 10 }, () => first());
  assert.deepEqual(Array.from({ length: 10 }, () => second()), values);
  assert(values.every(value => value >= 0 && value < 1));
});

test('stream input errors and invalid compressed checksums reject rather than hang', { timeout: 5000 }, async t => {
  const dataDir = await temporaryDirectory(t);
  const consume = async path => { for await (const line of readLines(path)) assert.equal(typeof line, 'string'); };
  for (const extension of ['txt', 'gz', 'bz2']) {
    await assert.rejects(consume(join(dataDir, `missing.${extension}`)), { code: 'ENOENT' });
  }
  const gzip = compress(Buffer.from('CRC check\n'), 'gzip');
  gzip[gzip.length - 8] ^= 1; // First byte of gzip's uncompressed-data CRC32 trailer.
  const bzip = compress(Buffer.from('CRC check\n'));
  bzip[10] ^= 1; // First byte of block CRC, after BZh9 and the six-byte block marker.
  for (const [extension, bytes] of [['gz', gzip], ['bz2', bzip]]) {
    const path = join(dataDir, `corrupt.${extension}`);
    await writeFile(path, bytes);
    await assert.rejects(consume(path));
  }
});
