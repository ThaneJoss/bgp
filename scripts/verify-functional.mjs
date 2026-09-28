import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import assert from 'node:assert/strict';

const vite = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true }, appType: 'custom', resolve: { alias: { '@': process.cwd() } } });
const originalFetch = globalThis.fetch, originalWorker = globalThis.Worker;
class MockWorker {
  static instances = [];
  constructor() { this.messages = []; MockWorker.instances.push(this); }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(data) { this.onmessage?.({ data }); }
}
try {
  globalThis.fetch = async () => { throw Error('Unexpected data request'); };
  globalThis.Worker = MockWorker;
  const { default: Home } = await vite.ssrLoadModule('/app/page.tsx');
  const { default: Paths } = await vite.ssrLoadModule('/app/paths/page.tsx');
  const home = renderToString(createElement(Home)), paths = renderToString(createElement(Paths));
  assert(home.includes('获取拓扑数据')); assert(paths.includes('获取 BGP 数据'));
  assert(paths.includes('导入本地文件')); assert(paths.includes('快照日期（UTC）'));
  assert(paths.includes('query-button" disabled=""'));
  assert(paths.includes('href="/paths"')); assert(!paths.includes('GLOBAL NETWORK EXPLORER'));
  const { GET: legacy } = await vite.ssrLoadModule('/app/api/paths/route.ts');
  const { GET: retired } = await vite.ssrLoadModule('/app/api/bgp/[...path]/route.ts');
  assert.equal((await legacy()).status, 410); assert.equal((await retired()).status, 410);
  const client = await vite.ssrLoadModule('/lib/bgp-client.ts');
  assert.equal(client.getBGPMetadata(), null);
  assert.equal(MockWorker.instances.length, 0);
  await assert.rejects(() => client.compareBGPPaths('1.1.1.1', '8.8.8.8', 'p0'), /获取数据/);
  console.log('PASS: initial pages show manual controls, block queries and perform no data requests.');

  const meta = { snapshotId: 'test', dataTime: '2026-01-01T00:00:00Z', defaultPeer: 'p0', peers: [], routeCount: 2, collector: { id: 'hkix.hkg', location: 'HKIX' } };
  let progress;
  const first = client.loadBGPData({ date: '2026-01-01', onProgress: value => { progress = value; } });
  const worker = MockWorker.instances[0], id = worker.messages[0].id;
  assert.equal(worker.messages[0].type, 'load');
  await assert.rejects(() => client.loadBGPData({ date: '2026-01-01', onProgress() {} }), /已有/);
  worker.emit({ id, type: 'progress', progress: { downloaded: 10 } });
  assert.equal(progress.downloaded, 10); assert.equal(client.getBGPMetadata(), null);
  worker.emit({ id, type: 'ready', metadata: meta });
  assert.equal(await first, meta);
  const query = client.compareBGPPaths(' 1.1.1.1 ', '8.8.8.8', 'p0');
  const request = worker.messages.at(-1);
  assert.equal(request.a, '1.1.1.1'); assert.equal(request.type, 'compare');
  worker.emit({ id: request.id, type: 'result', results: [{ status: 'ok' }, { status: 'missing_family' }] });
  assert.equal((await query)[1].status, 'missing_family');

  const failed = client.loadBGPData({ date: '2026-01-02', onProgress() {} });
  const failure = MockWorker.instances.at(-1);
  failure.emit({ id: failure.messages[0].id, type: 'error', error: 'bad CRC' });
  await assert.rejects(() => failed, /CRC/);
  assert.equal(failure.terminated, true); assert.equal(worker.terminated, undefined);
  assert.equal(client.getBGPMetadata(), meta);

  const file = new File(['fixture'], 'rib.bz2');
  const cancelled = client.loadBGPData({ date: '2026-01-02', file, onProgress() {} });
  const candidate = MockWorker.instances.at(-1);
  assert.equal(candidate.messages[0].file, file);
  client.cancelBGPDownload();
  await assert.rejects(() => cancelled, { name: 'AbortError' });
  candidate.emit({ id: candidate.messages[0].id, type: 'ready', metadata: { ...meta, snapshotId: 'late' } });
  assert.equal(client.getBGPMetadata(), meta);
  assert.equal(candidate.terminated, true);

  const refreshed = client.loadBGPData({ date: '2026-01-02', onProgress() {} });
  const replacement = MockWorker.instances.at(-1), next = { ...meta, snapshotId: 'new' };
  replacement.emit({ id: replacement.messages[0].id, type: 'ready', metadata: next });
  assert.equal(await refreshed, next); assert.equal(worker.terminated, true);
  console.log('PASS: progress, local query, duplicate load, file import, cancellation, late messages, failure preservation and atomic refresh.');
} finally {
  globalThis.fetch = originalFetch; globalThis.Worker = originalWorker;
  await vite.close();
}
