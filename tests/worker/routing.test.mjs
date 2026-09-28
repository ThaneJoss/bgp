import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadBGP } from '../../src/bgp-download.mjs';
import { createWorker } from '../../src/worker-routing.mjs';

test('download relays the fixed upstream stream without reading it or requiring storage', async () => {
  const request = new Request('https://example.com/api/bgp/download?date=2026-01-01');
  let pulls = 0;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array([66, 90, 104, 57])); controller.close(); } }, { highWaterMark: 0 });
  const response = await downloadBGP(request, async (url, init) => {
    assert.equal(url, 'https://archive.routeviews.org/hkix.hkg/bgpdata/2026.01/RIBS/rib.20260101.0000.bz2');
    assert.equal(init.signal, request.signal);
    assert.equal(init.cache, 'no-store');
    return new Response(body, { headers: { 'Content-Length': '4' } });
  });
  assert.equal(pulls, 0);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.body, body);
  assert.equal(await response.text(), 'BZh9');
});

test('bad dates and methods never fetch; upstream errors are actionable', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response('missing', { status: 404 }); };
  for (const url of ['?date=2026-02-30', '?date=https://example.com', '']) assert.equal((await downloadBGP(new Request(`https://example.com/api/bgp/download${url}`), fetcher)).status, 400);
  assert.equal((await downloadBGP(new Request('https://example.com/api/bgp/download?date=2026-01-01', { method: 'POST' }), fetcher)).status, 405);
  assert.equal(calls, 0);
  assert.equal((await downloadBGP(new Request('https://example.com/api/bgp/download?date=2026-01-01'), fetcher)).status, 404);
  assert.equal((await downloadBGP(new Request('https://example.com/api/bgp/download?date=2026-01-01'), async () => new Response('x', { headers: { 'Content-Length': '1073741825' } }))).status, 413);
  assert.equal((await downloadBGP(new Request('https://example.com/api/bgp/download?date=2026-01-01'), async () => { throw Error('offline'); })).status, 502);
});

test('website stays accessible, retired query/publisher cannot run, download is explicit', async () => {
  let websiteCalls = 0, downloads = 0;
  const worker = createWorker({ website: { fetch() { websiteCalls++; return new Response('website'); } }, download() { downloads++; return new Response('raw'); } });
  assert.equal(await (await worker.fetch(new Request('https://example.com/'), {})).text(), 'website');
  for (const path of ['/api/bgp/manifest', '/api/bgp/compare?a=1.1.1.1', '/_ingest', '/_ingest/upload', '/api/bgp']) assert.equal((await worker.fetch(new Request(`https://example.com${path}`), {})).status, 410);
  assert.equal(downloads, 0);
  assert.equal(await (await worker.fetch(new Request('https://example.com/api/bgp/download?date=2026-01-01'), {})).text(), 'raw');
  assert.equal(downloads, 1); assert.equal(websiteCalls, 1);
});
