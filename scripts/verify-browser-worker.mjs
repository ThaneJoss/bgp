// Exercise the exact production browser bundle in an isolated JS worker.
// Node provides the same Streams/Blob/Fetch APIs; no BGP network access occurs.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { fixture, compress } from '../tests/bgp/fixtures.mjs';

const directory = 'dist/client/_next/static';
const filename = readdirSync(directory).find(name => /^browser-worker-.*\.js$/.test(name));
assert(filename, 'Build the browser worker before running this check.');
const url = pathToFileURL(resolve(directory, filename)).href;
const packed = compress(fixture()).toString('base64');
const adapter = `
import { parentPort } from 'node:worker_threads';
globalThis.self = { postMessage: message => parentPort.postMessage(message) };
globalThis.fetch = async input => {
  if (input !== '/api/bgp/download?date=2026-09-27') throw new Error('Unexpected request: ' + input);
  const bytes = Buffer.from(${JSON.stringify(packed)}, 'base64');
  return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
};
await import(${JSON.stringify(url)});
parentPort.on('message', data => self.onmessage({ data }));
parentPort.postMessage({ type: 'booted' });
`;
const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(adapter)}`));
const timeout = setTimeout(() => { console.error('Browser worker verification timed out'); process.exitCode = 1; worker.terminate(); }, 20000);
async function request(message, type) {
  const result = new Promise((resolve, reject) => {
    const receive = data => {
      if (data.id !== message.id || data.type === 'progress') return;
      worker.off('message', receive);
      if (data.type !== type) reject(new Error(JSON.stringify(data))); else resolve(data);
    };
    worker.on('message', receive);
  });
  worker.postMessage(message);
  return result;
}
try {
  assert.equal((await once(worker, 'message'))[0].type, 'booted');
  const ready = await request({ id: 1, type: 'load', date: '2026-09-27' }, 'ready');
  assert.equal(ready.metadata.routeCount, 6);
  const result = await request({ id: 2, type: 'compare', a: '1.1.1.1', b: '8.8.8.8', peer: ready.metadata.defaultPeer }, 'result');
  assert.deepEqual(result.results.map(result => result.routes[0].path), [[3491, 13335], [3491, 15169]]);
  await request({ id: 3, type: 'compare', a: 'invalid', b: '8.8.8.8', peer: ready.metadata.defaultPeer }, 'error');
  const local = await request({ id: 4, type: 'load', file: new File([compress(fixture())], 'rib.bz2') }, 'ready');
  assert.equal(local.metadata.routeCount, 6);
  console.log('PASS: production browser Worker bundle downloads, decompresses, imports files, queries and reports errors in an isolated thread.');
} finally {
  clearTimeout(timeout);
  await worker.terminate();
}
