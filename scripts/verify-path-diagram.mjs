import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const vite=await createServer({configFile:false,plugins:[react()],server:{middlewareMode:true},appType:'custom',resolve:{alias:{'@':process.cwd()}}});
try {
 const {default:Diagram,splitPaths}=await vite.ssrLoadModule('/components/path-diagram.tsx');
 const route=(path,prefix)=>({rrc:'rrc01',location:'London, United Kingdom',peer:'5.57.80.113',prefix,path,observedAt:'2026-09-22T11:00:00Z'});
 const names={};
 for(const n of [15692,13335,15169])Object.assign(names,JSON.parse(fs.readFileSync(`public/data/explorer/names/${n%256}.json`,'utf8')));
 const html=renderToStaticMarkup(createElement(Diagram,{a:route([15692,13335],'1.1.1.0/24'),b:route([15692,15169],'8.8.8.0/24'),ipA:'1.1.1.1',ipB:'8.8.8.8',fetchedAt:'2026-09-22T11:00:00Z',initialNames:names}));
 assert.equal((html.match(/href="\/\?asn=15692"/g)||[]).length,1,'Shared network must appear once');
 assert(html.includes('Razorblue Ltd'));assert(html.includes('Cloudflare, Inc.'));assert(html.includes('Google LLC'));assert(html.includes('1.1.1.1'));assert(html.includes('8.8.8.8'));assert(html.includes('先共同经过 1 个网络'));
 const crossed=splitPaths([1,2,3],[1,4,3]);assert.deepEqual(crossed.trunk,[1]);assert.deepEqual(crossed.branches,[[2,3],[4,3]]);assert(crossed.laterCommon.has(3));
 const cases=[[[1,2],[1,2]],[[1,2],[1,2,3]],[[1,2],[4,5]],[[1,2,3,2],[1,2,4,2]]];
 for(const [a,b] of cases){const p=splitPaths(a,b);assert.deepEqual([...p.trunk,...p.branches[0]],a);assert.deepEqual([...p.trunk,...p.branches[1]],b);}
 console.log('PASS: supplied screenshot case renders one shared Razorblue node, separate Cloudflare/Google branches, explicit target IPs and source. Identical, prefix-contained, disjoint, and rejoining paths preserve every ordered AS hop.');
} finally {await vite.close();}
