'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Expand, Globe2, Loader2, Minus, Network, Plus, Search, X } from 'lucide-react';

type Summary = { meta: { date: string; totalAS: number; totalLinks: number }; groups: { id: string; label: string; seedAsn: number; asnCount: number }[]; links: { source: string; target: string; count: number }[] };
type Index = Record<string, [string, string, string, number]>;
type Vertex = { id: string; label: string; sub: string; count: number; x: number; y: number; asn?: number; color: string };
type Edge = { source: string; target: string; count: number; relationship?: string };
type Scene = { kind: 'world' | 'group' | 'tile' | 'as'; id: string; label: string; group?: string; tile?: string; asn?: number; nodes: Vertex[]; links: Edge[]; date: string };
type GroupData = { id: string; label: string; count: number; children: { id: string; label: string; count: number; seedAsn: number; x: number; y: number }[]; links: Edge[] };
type TileData = { id: string; parent: string; label: string; count: number; nodes: { asn: number; name: string; degree: number; group: string; x: number; y: number }[]; links: { source: number; target: number; relationship: string }[] };
type AdjData = Record<string, { neighbors: [number, string][] }>;
const colors = ['#2563eb', '#059c86', '#7a5bcc', '#008db3', '#d39429'];
const short = (s: string) => s.length > 25 ? s.slice(0, 23) + '…' : s;
const fmt = (n: number) => n.toLocaleString('en-US');
const groupColor = (g: string) => colors[(Number(g.replace(/\D/g, '')) - 1) % colors.length] || colors[0];
const relation = (r?: string) => r === 'peer' ? '对等网络' : r === 'provider' ? '上游网络' : r === 'customer' ? '下游网络' : 'AS 关系';

function arrange<T extends { x: number; y: number }>(nodes: T[]): T[] {
  if (!nodes.length) return [];
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 1);
  return nodes.map(n => ({ ...n, x: (n.x - (minX + maxX) / 2) / span * 840, y: (n.y - (minY + maxY) / 2) / span * 680 }));
}

function MapCanvas({ scene, open, busy }: { scene: Scene; open: (n: Vertex) => void; busy: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 590 });
  const [camera, setCamera] = useState({ x: 0, y: 0, k: 1 });
  const cameraRef = useRef(camera); cameraRef.current = camera;
  const pointers = useRef(new Map<number, {x:number;y:number}>());
  const gesture = useRef<{ x: number; y: number; startX: number; startY: number; moved: boolean; pinch: boolean } | null>(null);
  const [hover, setHover] = useState<Vertex | null>(null);
  const ratio = Math.min(size.w / 1080, size.h / 850);
  const nodes = useMemo(() => arrange(scene.nodes), [scene]);
  const map = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);
  const radius = useCallback((n: Vertex) => scene.kind === 'world' ? 12 + Math.sqrt(n.count / 23545) * 17 : scene.kind === 'group' ? 8 + Math.sqrt(n.count / 300) * 9 : n.asn === scene.asn ? 17 : 4 + Math.min(5, Math.log2(n.count + 1) * .5), [scene]);
  useEffect(() => { setCamera({ x: 0, y: 0, k: 1 }); setHover(null); }, [scene]);
  useEffect(() => { const el = host.current; if (!el) return; const observer = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height })); observer.observe(el); return () => observer.disconnect(); }, []);
  useEffect(() => {
    const el = canvas.current; if (!el) return;
    const zoom = (e: WheelEvent) => { e.preventDefault(); const rect = el.getBoundingClientRect(); const px = e.clientX - rect.left - size.w / 2, py = e.clientY - rect.top - size.h / 2; setCamera(c => { const k = Math.max(.35, Math.min(16, c.k * Math.exp(-e.deltaY * .0018))); return { x: px - (px - c.x) * k / c.k, y: py - (py - c.y) * k / c.k, k }; }); };
    el.addEventListener('wheel', zoom, { passive: false }); return () => el.removeEventListener('wheel', zoom);
  }, [size]);
  useEffect(() => {
    const el = canvas.current, ctx = el?.getContext('2d'); if (!el || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2); el.width = size.w * dpr; el.height = size.h * dpr;
    ctx.scale(dpr, dpr); ctx.fillStyle = '#fbfcff'; ctx.fillRect(0, 0, size.w, size.h);
    ctx.fillStyle = '#dce4ef'; const step = 26;
    for (let x = (camera.x % step + step) % step; x < size.w; x += step) for (let y = (camera.y % step + step) % step; y < size.h; y += step) { ctx.beginPath(); ctx.arc(x, y, .7, 0, Math.PI * 2); ctx.fill(); }
    const scale = ratio * camera.k;
    const point = (n: Vertex) => ({x: size.w / 2 + camera.x + n.x * scale, y: size.h / 2 + camera.y + n.y * scale});
    const max = Math.max(1, ...scene.links.map(e => e.count));
    for (const edge of scene.links) {
      const a = map.get(edge.source), b = map.get(edge.target); if (!a || !b) continue;
      const p = point(a), q = point(b); const active = hover && (hover.id === edge.source || hover.id === edge.target);
      ctx.strokeStyle = active ? '#467bc9' : edge.relationship === 'peer' ? '#abcfc7' : '#c1cee0';
      ctx.globalAlpha = hover ? active ? .9 : .12 : scene.nodes.length > 700 ? .28 : .6;
      ctx.lineWidth = scene.kind === 'world' || scene.kind === 'group' ? .5 + Math.sqrt(edge.count / max) * 2.6 : .7;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const labelEvery = scene.nodes.length < 80 ? 1 : scene.nodes.length < 350 ? 8 : 40;
    nodes.forEach((node, i) => {
      const p = point(node); if (p.x < -100 || p.y < -70 || p.x > size.w + 100 || p.y > size.h + 70) return;
      const r = radius(node) * Math.max(.75, Math.min(1.8, Math.sqrt(camera.k)));
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fillStyle = node.color; ctx.fill();
      if (node === hover || node.asn === scene.asn) { ctx.strokeStyle = node.color; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x,p.y,r+6,0,Math.PI*2); ctx.stroke(); }
      if (scene.kind === 'world') { ctx.font = '600 12px system-ui'; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(node.count > 999 ? (node.count/1000).toFixed(1)+'k' : String(node.count),p.x,p.y+4); }
      if (node === hover || node.asn === scene.asn || camera.k > 2.3 || i % labelEvery === 0) {
        const label = short(node.label); ctx.font = '500 12px system-ui'; ctx.textAlign = 'center'; ctx.lineWidth = 4; ctx.strokeStyle = '#fbfcff'; ctx.strokeText(label, p.x, p.y + r + 19); ctx.fillStyle = '#334866'; ctx.fillText(label, p.x, p.y + r + 19);
      }
    });
  }, [scene, nodes, map, size, camera, ratio, hover, radius]);
  const hit = (x: number, y: number) => { let best: Vertex | null = null, distance = Infinity; for (const n of nodes) { const dx = x - (size.w/2 + cameraRef.current.x + n.x*ratio*cameraRef.current.k), dy = y - (size.h/2 + cameraRef.current.y + n.y*ratio*cameraRef.current.k); const d = Math.hypot(dx,dy); if (d < Math.max(13, radius(n)*Math.max(.75,Math.min(1.8,Math.sqrt(cameraRef.current.k)))+4) && d < distance) { distance=d; best=n; } } return best; };
  return <div className="atlas-canvas" ref={host}>
    <canvas ref={canvas} aria-label={`${scene.label}，${scene.nodes.length} 个节点。可通过左侧节点列表进行键盘操作。`} style={{ cursor: hover ? 'pointer' : 'grab' }}
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY}); gesture.current = {x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false,pinch:pointers.current.size>1}; }}
      onPointerMove={e => {
        const g = gesture.current, prev = pointers.current.get(e.pointerId);
        if (g && prev) {
          if (pointers.current.size === 2) { const other = [...pointers.current.entries()].find(([id])=>id!==e.pointerId)![1]; const before=Math.hypot(prev.x-other.x,prev.y-other.y), after=Math.hypot(e.clientX-other.x,e.clientY-other.y); if(before>0) setCamera(c=>({...c,k:Math.max(.35,Math.min(16,c.k*after/before))})); g.pinch=true; }
          else setCamera(c=>({...c,x:c.x+e.clientX-prev.x,y:c.y+e.clientY-prev.y}));
          if(Math.hypot(e.clientX-g.startX,e.clientY-g.startY)>5)g.moved=true;
          pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});
        } else { const rect=e.currentTarget.getBoundingClientRect(); setHover(hit(e.clientX-rect.left,e.clientY-rect.top)); }
      }}
      onPointerUp={e=>{const g=gesture.current; pointers.current.delete(e.pointerId); if(g&&!g.moved&&!g.pinch&&!busy){const r=e.currentTarget.getBoundingClientRect();const n=hit(e.clientX-r.left,e.clientY-r.top);if(n)open(n);}if(!pointers.current.size)gesture.current=null;}}
      onPointerCancel={e=>{pointers.current.delete(e.pointerId);gesture.current=null;}} onPointerLeave={()=>setHover(null)}/>
    <div className="atlas-map-tools"><button aria-label="放大地图" onClick={()=>setCamera(c=>({...c,k:Math.min(16,c.k*1.4)}))}><Plus size={18}/></button><button aria-label="缩小地图" onClick={()=>setCamera(c=>({...c,k:Math.max(.35,c.k/1.4)}))}><Minus size={18}/></button><button aria-label="适应地图" onClick={()=>setCamera({x:0,y:0,k:1})}><Expand size={17}/></button><span>{Math.round(camera.k*100)}%</span></div>
    <div className="atlas-map-caption">{scene.kind === 'world' ? '点选社区进入' : scene.kind === 'group' ? '点选区块查看全部 AS' : '点选 AS 查看全部邻居'} · 滚轮缩放 · 拖动平移</div>
    {hover && <div className="atlas-hover"><strong>{hover.label}</strong><span>{hover.sub}</span><small>{fmt(hover.count)} {scene.kind === 'world'||scene.kind === 'group'?'个 AS':'个邻居'}</small></div>}
    {busy && <div className="atlas-busy" role="status"><Loader2 className="spin" size={18}/>正在加载这一层…</div>}
  </div>;
}

export default function MapExplorer({ snapshot }: { snapshot: Summary }) {
  const world = useMemo<Scene>(() => ({ kind:'world',id:'world',label:'全球网络',date:snapshot.meta.date,nodes:snapshot.groups.map((g,i)=>({id:g.id,label:short(g.label),sub:`核心 AS${g.seedAsn}`,count:g.asnCount,x:Math.cos(i*2.399963)*Math.sqrt(i+1)*100,y:Math.sin(i*2.399963)*Math.sqrt(i+1)*100,color:groupColor(g.id)})),links:snapshot.links }),[snapshot]);
  const [scene,setScene]=useState<Scene>(world);
  const [history,setHistory]=useState<Scene[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [query,setQuery]=useState(''),[index,setIndex]=useState<Index|null>(null),[indexBusy,setIndexBusy]=useState(false),[indexError,setIndexError]=useState('');
  const [searchResults,setSearchResults]=useState<[string,Index[string]][]>([]);
  const [listLimit,setListLimit]=useState(60),[listFilter,setListFilter]=useState('');
  const cache=useRef(new Map<string,unknown>()), indexPromise=useRef<Promise<Index>|null>(null),requestId=useRef(0);
  const load = useCallback(async <T,>(name:string):Promise<T>=>{if(cache.current.has(name))return cache.current.get(name) as T;const r=await fetch(`/data/explorer/${name}.json`,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error('这一层的数据暂时无法加载，请重试。');const data=await r.json() as T;if(cache.current.size>=24)cache.current.delete(cache.current.keys().next().value!);cache.current.set(name,data);return data;},[]);
  const ensureIndex=useCallback(async()=>{if(index)return index;if(!indexPromise.current){setIndexBusy(true);setIndexError('');indexPromise.current=load<Index>('index').then(data=>{setIndex(data);return data;}).catch(e=>{indexPromise.current=null;setIndexError('搜索索引加载失败，请重新输入重试。');throw e;}).finally(()=>setIndexBusy(false));}return indexPromise.current;},[index,load]);
  const setAddress = (s:Scene) => { const key = s.kind === 'world' ? '' : s.kind === 'as' ? 'asn' : s.kind; window.history.replaceState(null, '', key ? `/?${key}=${encodeURIComponent(s.id)}` : '/'); };
  const navigate=useCallback(async(kind:'group'|'tile'|'as',id:string,focusASN?:number)=>{
    const token=++requestId.current;setBusy(true);setError('');
    try{let next:Scene;
      if(kind==='group'){const d=await load<GroupData>(id);next={kind,id,label:d.label,group:id,date:snapshot.meta.date,nodes:d.children.map(c=>({id:c.id,label:c.label,sub:`核心 AS${c.seedAsn}`,count:c.count,x:c.x,y:c.y,color:groupColor(id)})),links:d.links};}
      else if(kind==='tile'){const d=await load<TileData>(id);next={kind,id,label:d.label,group:d.parent,tile:id,asn:focusASN,date:snapshot.meta.date,nodes:d.nodes.map(n=>({id:String(n.asn),asn:n.asn,label:`AS${n.asn}`,sub:n.name,count:n.degree,x:n.x,y:n.y,color:groupColor(n.group)})),links:d.links.map(e=>({...e,source:String(e.source),target:String(e.target),count:1}))};}
      else{const asn=Number(id);const [all,shard]=await Promise.all([ensureIndex(),load<AdjData>(`adj/${asn%256}`)]);const info=all[id];const entry=shard[id];if(!info||!entry)throw new Error('该 ASN 不在当前 CAIDA 快照中。');
        const neighbors=[...entry.neighbors].sort((a,b)=>(all[String(b[0])]?.[3]||0)-(all[String(a[0])]?.[3]||0));
        const nodes:Vertex[]=[{id,asn,label:`AS${asn}`,sub:info[2],count:info[3],x:0,y:0,color:groupColor(info[0])},...neighbors.map(([n],i)=>{const data=all[String(n)];const a=i*2.399963,r=120+Math.sqrt((i+1)/Math.max(neighbors.length,1))*440;return{id:String(n),asn:n,label:`AS${n}`,sub:data?.[2]||`AS${n}`,count:data?.[3]||0,x:Math.cos(a)*r,y:Math.sin(a)*r,color:groupColor(data?.[0]||'g01')};})];
        next={kind,id,label:`AS${asn} · ${info[2]}`,group:info[0],tile:info[1],asn,date:snapshot.meta.date,nodes,links:neighbors.map(([n,r])=>({source:id,target:String(n),count:1,relationship:r}))};
      }
      if(token!==requestId.current)return;setHistory(h=>[...h,scene].slice(-20));setScene(next);setAddress(next);setQuery('');setListLimit(60);setListFilter('');
    }catch(e){if(token===requestId.current)setError(e instanceof Error?e.message:'加载失败，请重试。');}finally{if(token===requestId.current)setBusy(false);}
  },[load,ensureIndex,scene,snapshot.meta.date]);
  useEffect(()=>{if(!query.trim()){setSearchResults([]);return;}let cancelled=false;setSearchResults([]);const t=setTimeout(()=>{ensureIndex().then(all=>{if(cancelled)return;const q=query.trim().replace(/^AS(?=\d)/i,'').toLowerCase();if(/^\d+$/.test(q)){setSearchResults(all[q]?[[q,all[q]]]:[]);return;}const found:[string,Index[string]][]=[];for(const entry of Object.entries(all)){if(entry[1][2].toLowerCase().includes(q)){found.push(entry);if(found.length===20)break;}}setSearchResults(found);}).catch(()=>{});},200);return()=>{cancelled=true;clearTimeout(t);};},[query,ensureIndex]);
  useEffect(()=>{const handle=(e:Event)=>{navigate('group',(e as CustomEvent<string>).detail);};window.addEventListener('atlas:open-group',handle);return()=>window.removeEventListener('atlas:open-group',handle);},[navigate]);
  const initialSearch = useRef(false);
  useEffect(() => { if (initialSearch.current) return; initialSearch.current = true; const params = new URLSearchParams(window.location.search); const asn = params.get('asn'), group = params.get('group'), tile = params.get('tile'); if (asn && /^\d+$/.test(asn)) navigate('as', asn); else if (tile && /^g\d{2}-c\d{3}$/.test(tile)) navigate('tile',tile); else if (group && /^g\d{2}$/.test(group)) navigate('group',group); }, [navigate]);
  const open=(n:Vertex)=>{if(busy)return;if(n.asn!==undefined){if(scene.kind!=='as'||n.asn!==scene.asn)navigate('as',String(n.asn));}else navigate(scene.kind==='world'?'group':'tile',n.id);};
  const back=()=>{requestId.current++;setBusy(false);setError('');const previous=history.at(-1);if(previous){setScene(previous);setAddress(previous);setHistory(history.slice(0,-1));}else {setScene(world);setAddress(world);}setListFilter('');setListLimit(60);};
  const reset=()=>{requestId.current++;setBusy(false);setError('');setScene(world);setAddress(world);setHistory([]);setQuery('');setListFilter('');setListLimit(60);};
  const localNodes=useMemo(()=>scene.nodes.filter(n=>n.asn!==scene.asn||scene.kind!=='as').filter(n=>!listFilter||`${n.label} ${n.sub}`.toLowerCase().includes(listFilter.toLowerCase())),[scene,listFilter]);
  const relationships=useMemo(()=>new Map(scene.links.map(l=>[l.target,l.relationship])),[scene]);
  return <section className="atlas-explorer">
    <aside className="atlas-sidebar"><div className="atlas-sidebar-title"><strong>网络地图</strong><span>{fmt(snapshot.meta.totalAS)} AS</span></div>
      <label className="search-box"><Search size={16}/><input aria-label="定位任意 ASN 或网络名称" placeholder="定位 ASN / 网络名称" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button aria-label="清空搜索" onClick={()=>setQuery('')}><X size={14}/></button>}</label>
      {query.trim()?<div className="atlas-search-results"><div className="atlas-list-heading">全量 AS 搜索</div>{indexBusy?<p className="atlas-note"><Loader2 className="spin" size={15}/>正在加载搜索索引…</p>:indexError?<p role="alert">{indexError}</p>:searchResults.length?searchResults.map(([asn,data])=><button key={asn} className="atlas-list-node" disabled={busy} onClick={()=>navigate('as',asn)}><span className="atlas-dot" style={{background:groupColor(data[0])}}/><span><strong>AS{asn}</strong><small>{data[2]}</small></span><ChevronRight size={14}/></button>):<p className="atlas-note">没有匹配的 ASN 或网络名称。</p>}</div>:<>
      {scene.kind!=='world'&&<button className="atlas-back" onClick={back}><ArrowLeft size={15}/>返回上一层</button>}
      <div className="atlas-scene-description"><span>{scene.kind==='world'?'第 1 层 · 全球社区':scene.kind==='group'?'第 2 层 · 社区区块':scene.kind==='tile'?'第 3 层 · 全部 AS':'AS 邻接关系'}</span><h2>{scene.label}</h2>{scene.kind==='as'&&<p>{fmt(scene.nodes.length-1)} 个直接邻居 · 快照 {scene.date}</p>}</div>
      {scene.kind==='as'&&<button className="button secondary atlas-locate" disabled={busy} onClick={()=>navigate('tile',scene.tile!,scene.asn)}>在所在区块中定位 <ChevronRight size={14}/></button>}
      {scene.kind!=='world'&&<input className="atlas-local-filter" aria-label="筛选当前节点" placeholder={scene.kind==='as'?'筛选邻居 ASN / 名称':'筛选当前节点'} value={listFilter} onChange={e=>{setListFilter(e.target.value);setListLimit(60);}}/>}
      <div className="atlas-list-heading"><span>{scene.kind==='world'?'选择社区':scene.kind==='group'?'选择区块':scene.kind==='as'?'全部直接邻居':'区块中的全部 AS'}</span><span>{fmt(localNodes.length)}</span></div>
      <div className="atlas-node-list">{localNodes.slice(0,listLimit).map(n=><button key={n.id} className="atlas-list-node" disabled={busy} onClick={()=>open(n)}><span className="atlas-dot" style={{background:n.color}}/><span><strong>{n.label}</strong><small>{scene.kind==='as'?`${relation(relationships.get(n.id))} · ${n.sub}`:n.asn?`${n.sub} · ${fmt(n.count)} 邻居`:`${fmt(n.count)} 个 AS · ${n.sub}`}</small></span><ChevronRight size={14}/></button>)}{localNodes.length>listLimit&&<button className="atlas-load-more" onClick={()=>setListLimit(n=>n+100)}>显示更多（还有 {fmt(localNodes.length-listLimit)} 个）</button>}</div>
      </>}
    </aside>
    <div className="atlas-main"><div className="atlas-toolbar"><div className="atlas-breadcrumb"><button onClick={reset} aria-label="返回全球网络"><Globe2 size={16}/>全球</button>{scene.group&&<><ChevronRight size={14}/><button disabled={busy} onClick={()=>navigate('group',scene.group!)}>{short(snapshot.groups.find(g=>g.id===scene.group)?.label||scene.group)}</button></>}{scene.tile&&<><ChevronRight size={14}/><button disabled={busy} onClick={()=>navigate('tile',scene.tile!)}>AS 区块</button></>}{scene.asn&&<><ChevronRight size={14}/><strong>AS{scene.asn}</strong></>}</div><span className="tag">{fmt(scene.nodes.length)} 节点</span></div>
      {error&&<div className="atlas-error" role="alert">{error}<button onClick={()=>setError('')} aria-label="关闭错误"><X size={14}/></button></div>}
      <MapCanvas scene={scene} open={open} busy={busy}/>
      <div className="atlas-footer"><span><i style={{background:colors[0]}}/>AS / 网络集合 <i style={{background:'#abcfc7'}}/>对等关系</span><span>{fmt(scene.links.length)} 条{scene.kind==='world'||scene.kind==='group'?'聚合':''}连接 · {scene.date}</span></div>
      <p className="atlas-method">{scene.kind==='as'?'当前显示中心 AS 的全部直接邻居；点击邻居可以继续探索跨社区关系。':scene.kind==='tile'?'当前区块中的全部 AS 与区块内真实关系。点选任意 AS 可查看跨区块的全部邻居。':scene.kind==='group'?'区块按图遍历分片，用于按需加载全部 AS；区块之间的连线来自真实 AS 关系。':'按连接结构聚合为 20 个社区。继续进入社区、区块和 AS，可探索当前快照覆盖的全部网络。'} 位置表示拓扑布局，并非地理位置。</p>
    </div>
  </section>;
}
