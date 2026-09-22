import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import worker from '../../workers/bgp-publisher/src/index.mjs';
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))('miniflare');

test('unauthorized requests never access R2', async () => {
  const env = { INGEST_TOKEN: 'secret', get BGP_BUCKET() { throw new Error('R2 touched'); } };
  assert.equal((await worker.fetch(new Request('https://example.com/objects'), env)).status, 401);
});

test('native R2 publisher preserves conditions, metadata, composition and listing', async () => {
  const mf = new Miniflare({ modules: true, scriptPath: fileURLToPath(new URL('../../workers/bgp-publisher/src/index.mjs', import.meta.url)),
    // The repository pins a May 2026 workerd; deployed configuration uses the current date.
    compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], r2Buckets: ['BGP_BUCKET'], bindings: { INGEST_TOKEN: 'secret' } });
  const call = (path, method='GET', body, headers={}) => mf.dispatchFetch(`http://localhost${path}`, {
    method, body, headers: { Authorization: 'Bearer secret', ...(body !== undefined ? {'Content-Length': String(Buffer.byteLength(body))} : {}), ...headers } });
  try {
    assert.equal((await call('/objects/latest.json')).status, 404);
    let response = await call('/objects/latest.json', 'PUT', 'first', {'If-None-Match':'*', 'Content-Type':'application/json', 'x-amz-meta-sha256':'test'});
    assert.equal(response.status, 200, await response.text());
    assert.equal(response.headers.get('Content-Length'), null);
    const etag = response.headers.get('etag');
    assert.match(etag, /^".+"$/);
    assert.equal((await call('/objects/latest.json','PUT','other',{'If-None-Match':'*'})).status,412);
    assert.equal((await call('/objects/latest.json','PUT','other',{'If-Match':'"wrong"'})).status,412);
    response = await call('/objects/latest.json','HEAD');
    assert.equal(response.headers.get('x-amz-meta-sha256'),'test');
    assert.equal(response.headers.get('Content-Type'),'application/json');
    await call('/objects/_uploads%2Frun%2F0','PUT','abc');
    await call('/objects/_uploads%2Frun%2F1','PUT','def');
    const compose = JSON.stringify({parts:['_uploads/run/0','_uploads/run/1'],size:6});
    response = await call('/compose/snapshots%2Ftest%2Fdata','POST',compose,{'If-None-Match':'*','x-amz-meta-sha256':'combined'});
    assert.equal(response.status,200,await response.text());
    assert.equal(response.headers.get('Content-Length'), null);
    assert.equal(await (await call('/objects/snapshots%2Ftest%2Fdata')).text(),'abcdef');
    assert.equal((await call('/compose/snapshots%2Ftest%2Fdata','POST',compose,{'If-None-Match':'*'})).status,412);
    assert.equal((await call('/compose/snapshots%2Ftest%2Fwrong','POST',JSON.stringify({parts:['_uploads/run/0'],size:4}))).status,400);
    assert.equal((await call('/compose/snapshots%2Ftest%2Fwrong','POST',compose,{'Content-MD5':'AAAAAAAAAAAAAAAAAAAAAA=='})).status,400);
    assert.equal((await call('/objects/snapshots%2Ftest%2Fwrong')).status,404);
    const listing = await (await call('/objects')).json();
    assert.ok(listing.Contents.some(x => x.Key === 'latest.json' && x.Size === 5));
    assert.equal(listing.NextCursor,null);
    assert.equal((await call('/objects/latest.json','PUT','second',{'If-Match':etag})).status,200);
    assert.equal((await call('/objects/_uploads%2Frun%2F0','DELETE')).status,204);
  } finally { await mf.dispose(); }
});


test('listing passes native cursor and reports the next page', async () => {
  const response = await worker.fetch(new Request('https://example.com/objects?cursor=next', {headers:{Authorization:'Bearer secret'}}), {
    INGEST_TOKEN:'secret', BGP_BUCKET:{async list(options) {
      assert.equal(options.cursor,'next');
      return {objects:[{key:'latest.json',size:7}],truncated:true,cursor:'after'};
    }}
  });
  assert.deepEqual(await response.json(),{Contents:[{Key:'latest.json',Size:7}],NextCursor:'after'});
});


test('native R2 thrown precondition errors return 412 without masking other failures', async () => {
  for (const [message, status] of [['R2 put failed: (10031) PreconditionFailed', 412], ['backend unavailable', 500]]) {
    const request = new Request('https://example.com/objects/latest.json', {method:'PUT',body:'test',headers:{Authorization:'Bearer secret'}});
    const response = await worker.fetch(request,{INGEST_TOKEN:'secret',BGP_BUCKET:{async put(){throw new Error(message);}}});
    assert.equal(response.status,status);
  }
});
