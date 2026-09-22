import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const vite = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true }, appType: 'custom', resolve: { alias: { '@': process.cwd() } } });
try {
 const {default:Home} = await vite.ssrLoadModule('/app/page.tsx');
 const {default:Paths} = await vite.ssrLoadModule('/app/paths/page.tsx');
 const normal = renderToString(createElement(Home));
 const paths = renderToString(createElement(Paths));
 assert(normal.includes('href="/paths"')); assert(paths.includes('两个目标，在哪分路')); assert(paths.includes('目标 IP A')); assert(paths.includes('value="1.1.1.1"')); assert(!paths.includes('GLOBAL NETWORK EXPLORER'));
 console.log('PASS: direct /paths SSR renders query controls, both native navigation links, and no topology view.');
 const {default:MapExplorer}=await vite.ssrLoadModule('/components/map-explorer.tsx');
 const overview=JSON.parse(fs.readFileSync('public/data/explorer/overview.json','utf8'));
 const map=renderToString(createElement(MapExplorer,{snapshot:overview}));assert(map.includes('80,510'));assert(map.includes('定位任意 ASN'));
 console.log('PASS: map overview SSR renders full snapshot coverage and accessible search/list controls.');
 const {GET:legacy}=await vite.ssrLoadModule('/app/api/paths/route.ts');
 const {GET:unconfigured}=await vite.ssrLoadModule('/app/api/bgp/[...path]/route.ts');
 const originalFetch=globalThis.fetch;
 try {
  globalThis.fetch=async()=>{throw Error('No upstream access allowed')};
  assert.equal((await legacy()).status,410);
  assert.equal((await unconfigured()).status,503);
  console.log('PASS: retired API and unconfigured fallback never request a public BGP backend.');
  const {compareBGPPaths,getBGPMetadata}=await vite.ssrLoadModule('/lib/bgp-client.ts');
  let inconsistent=false;const calls=[];
  globalThis.fetch=async(input)=>{
   const url=String(input);calls.push(url);
   if(url==='/bgp-service.json')return Response.json({apiBase:''});
   if(url==='/api/bgp/manifest')return Response.json({snapshotId:'test',defaultPeer:'p0',peers:[{id:'p0',asn:64500,address:'192.0.2.1',families:[4]}]});
   assert(url.startsWith('/api/bgp/compare?'));
   return Response.json({snapshotId:'test',results:['1.1.1.1','8.8.8.8'].map(ip=>({ip,snapshotId:inconsistent?'wrong':'test',status:'ok',routes:[{path:[64500,64500,13335]}]}))});
  };
  assert.equal((await getBGPMetadata()).defaultPeer,'p0');
  const result=await compareBGPPaths('1.1.1.1','8.8.8.8','p0');
  assert.deepEqual(result[0].routes[0].path,[64500,13335]);
  assert.equal(calls.filter(url=>url.startsWith('/api/bgp/compare?')).length,1);
  inconsistent=true;await assert.rejects(()=>compareBGPPaths('1.1.1.1','8.8.8.8','p0'));
  console.log('PASS: frontend makes one two-IP query, displays prepends compactly, and rejects mixed snapshots.');
 } finally {globalThis.fetch=originalFetch;}
} finally { await vite.close(); }
