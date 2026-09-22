import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorker } from '../../src/worker-routing.mjs';
import query from '../../workers/bgp/src/index.mjs';
import publisher from '../../workers/bgp-publisher/src/index.mjs';

const unused = { fetch() { throw new Error('Unexpected handler'); } };

test('query goes directly to the R2 handler with the same environment', async () => {
  const keys = [];
  const env = { BGP_BUCKET: { async get(key) { keys.push(key); return null; } } };
  const worker = createWorker({ website: unused, query, publisher: unused });
  const response = await worker.fetch(new Request('https://bgp.example/api/bgp/manifest'), env, {});
  assert.equal(response.status, 503);
  assert.deepEqual(keys, ['latest.json']);
  assert.equal((await worker.fetch(new Request('https://bgp.example/api/bgp/unknown'), env)).status, 404);
});

test('ingest strips its prefix while preserving method, headers, query, and streaming body', async () => {
  let pulled = false;
  const stream = new ReadableStream({ pull(controller) { pulled = true; controller.enqueue(new Uint8Array([0, 255, 1])); controller.close(); } });
  const env = { BGP_BUCKET: {} }, ctx = {};
  const request = new Request('https://bgp.example/_ingest/objects/snapshots%2Ftest?cursor=a%2Fb', {
    method: 'PUT', headers: { Authorization: 'Bearer fixture', 'If-None-Match': '*', 'Content-Length': '3' },
    body: stream, duplex: 'half',
  });
  const worker = createWorker({ website: unused, query: unused, publisher: {
    async fetch(forwarded, gotEnv, gotCtx) {
      assert.equal(gotEnv, env); assert.equal(gotCtx, ctx);
      assert.equal(forwarded.url, 'https://bgp.example/objects/snapshots%2Ftest?cursor=a%2Fb');
      assert.equal(forwarded.method, 'PUT');
      assert.equal(forwarded.headers.get('Authorization'), 'Bearer fixture');
      assert.equal(forwarded.headers.get('If-None-Match'), '*');
      assert.equal(forwarded.bodyUsed, false);
      assert.deepEqual(new Uint8Array(await forwarded.arrayBuffer()), new Uint8Array([0, 255, 1]));
      return new Response(null, { status: 204 });
    },
  } });
  assert.equal((await worker.fetch(request, env, ctx)).status, 204);
  assert.equal(pulled, true);
});

test('ingest unknown routes and methods still pass through publisher authentication', async () => {
  const worker = createWorker({ website: unused, query: unused, publisher });
  const env = { INGEST_TOKEN: 'fixture', BGP_BUCKET: {} };
  for (const method of ['GET', 'PATCH']) {
    const response = await worker.fetch(new Request('https://bgp.example/_ingest/unknown', { method }), env);
    assert.equal(response.status, 401);
    const authenticated = await worker.fetch(new Request('https://bgp.example/_ingest/unknown', {
      method, headers: { Authorization: 'Bearer fixture' },
    }), env);
    assert.equal(authenticated.status, 404);
  }
});

test('authenticated publication list uses the shared R2 binding', async () => {
  let options;
  const env = { INGEST_TOKEN: 'fixture', BGP_BUCKET: {
    async list(value) { options = value; return { objects: [{ key: 'latest.json', size: 3 }], truncated: false }; },
  } };
  const worker = createWorker({ website: unused, query: unused, publisher });
  const response = await worker.fetch(new Request('https://bgp.example/_ingest/objects?cursor=next', {
    headers: { Authorization: 'Bearer fixture' },
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(options, { limit: 1000, cursor: 'next' });
  assert.deepEqual(await response.json(), { Contents: [{ Key: 'latest.json', Size: 3 }], NextCursor: null });
});

test('website receives the original request, environment, and context outside reserved prefixes', async () => {
  const env = {}, ctx = {};
  for (const path of ['/', '/data/explorer/overview.json', '/objects/hello', '/_ingestion/file']) {
    const request = new Request(`https://bgp.example${path}`);
    const worker = createWorker({ query: unused, publisher: unused, website: {
      fetch(received, gotEnv, gotCtx) {
        assert.equal(received, request); assert.equal(gotEnv, env); assert.equal(gotCtx, ctx);
        return new Response('website');
      },
    } });
    assert.equal(await (await worker.fetch(request, env, ctx)).text(), 'website');
  }
});
