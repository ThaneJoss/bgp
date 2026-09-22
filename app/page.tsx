'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronRight, CircleHelp, Database, Expand, GitBranch, Globe2, Layers3, Loader2, Network, Plus, Search, ShieldCheck, X, Minus, RefreshCw } from 'lucide-react';
import MapExplorer from '@/components/map-explorer';
import PathDiagram from '@/components/path-diagram';
import { compareBGPPaths, getBGPMetadata, type BGPMetadata, type BGPPathResult } from '@/lib/bgp-client';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

type Member = { asn: number; name: string; degree?: number };
type Group = { id: string; label: string; seedAsn: number; asnCount: number; members: Member[]; internalLinks: { source: number; target: number }[]; country?: string };
type Link = { source: string; target: string; count: number };
type Snapshot = { meta: { source: string; date: string; totalAS: number; totalLinks: number; grouping: string; groupingZh?: string }; groups: Group[]; links: Link[] };
type Route = { rrc: string; location: string; peer: string; prefix: string; path: number[]; observedAt: string };
type PathResult = BGPPathResult;
type GraphNode = { id: string; label: string; sub: string; count: number; x: number; y: number; radius: number; groupId?: string; asn?: number };
const palette = ['#2563eb', '#0d9488', '#7c5ce0', '#0891b2', '#d58b24'];
const shortName = (name: string) => name.replace(/,?\s*(Inc\.?|LLC|Limited|Ltd\.?|Corporation|Communications|Networks|Company|Co\., Ltd\.)\s*$/gi, '').slice(0, 24);
const number = (n?: number) => n === undefined ? '—' : new Intl.NumberFormat('en-US').format(n);

export default function Home({ initialView = 'topology' }: { initialView?: 'topology' | 'paths' }) {
  const [tab, setTab] = useState(initialView);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [dataError, setDataError] = useState('');
  const [ipA, setIpA] = useState('1.1.1.1'), [ipB, setIpB] = useState('8.8.8.8');
  const [loading, setLoading] = useState(false), [pathError, setPathError] = useState('');
  const [results, setResults] = useState<[PathResult, PathResult] | null>(null);
  const [observerKey, setObserverKey] = useState('');
  const [bgpMetadata, setBGPMetadata] = useState<BGPMetadata | null>(null);
  const [bgpPeer, setBGPPeer] = useState('');
  const [hasQueried, setHasQueried] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const queryId = useRef(0);
  const fetchSnapshot = useCallback(() => { setDataError(''); fetch('/data/explorer/overview.json').then(r => { if (!r.ok) throw new Error(); return r.json() as Promise<Snapshot>; }).then(setSnapshot).catch(() => setDataError('拓扑快照加载失败，请重试。')); }, []);
  useEffect(() => { if (tab === 'topology' && !snapshot) fetchSnapshot(); }, [fetchSnapshot, tab, snapshot]);
  useEffect(() => {
    if (tab !== 'paths') return;
    let active = true;
    getBGPMetadata().then(meta => { if (active) { setBGPMetadata(meta); setBGPPeer(current => current || meta.defaultPeer); } }).catch(error => { if (active) setPathError(error instanceof Error ? error.message : '路径库暂时不可用。'); });
    return () => { active = false; };
  }, [tab]);
  const queryPaths = useCallback(async (first = ipA, second = ipB, selectedPeer = bgpPeer) => {
    const current = ++queryId.current;
    setLoading(true); setPathError(''); setHasQueried(true); setResults(null); setObserverKey('');
    try {
      if (!first.trim() || !second.trim()) throw new Error('请填写两个目标 IP。');
      const meta = bgpMetadata ?? await getBGPMetadata();
      const peer = selectedPeer || meta.defaultPeer;
      const responses = await compareBGPPaths(first, second, peer);
      if (current !== queryId.current) return;
      setBGPMetadata(meta); setBGPPeer(peer);
      setResults(responses);
      const bKeys = new Set(responses[1].routes.map(r => `${r.rrc}|${r.peer}`));
      const matched = responses[0].routes.find(r => bKeys.has(`${r.rrc}|${r.peer}`));
      if (matched) setObserverKey(`${matched.rrc}|${matched.peer}`);
      return { routesA: responses[0].routes.length, routesB: responses[1].routes.length, sharedObserver: Boolean(matched) };
    } catch (e) { if (current === queryId.current) setPathError(e instanceof Error && e.name === 'TimeoutError' ? '查询超时，请稍后重试。' : e instanceof Error ? e.message : '查询失败，请重试。'); }
    finally { if (current === queryId.current) setLoading(false); }
  }, [ipA, ipB, bgpMetadata, bgpPeer]);
  const observers = useMemo(() => {
    if (!results) return [];
    const keys = new Set(results[1].routes.map(r => `${r.rrc}|${r.peer}`));
    const seen = new Set<string>();
    return results[0].routes.filter(r => { const key = `${r.rrc}|${r.peer}`; if (!keys.has(key) || seen.has(key)) return false; seen.add(key); return true; });
  }, [results]);
  const routeA = results?.[0].routes.find(r => `${r.rrc}|${r.peer}` === observerKey);
  const routeB = results?.[1].routes.find(r => `${r.rrc}|${r.peer}` === observerKey);
  useEffect(() => {
    const context = (document as unknown as { modelContext?: { registerTool: (tool: unknown, options: { signal: AbortSignal }) => unknown } }).modelContext;
    if (!context?.registerTool) return;
    const controller = new AbortController();
    const register = (tool: unknown) => { try { Promise.resolve(context.registerTool(tool, { signal: controller.signal })).catch(() => {}); } catch {} };
    register({ name: 'compare_ip_paths', description: 'Query and display BGP paths to two target IP addresses from a shared observer.', inputSchema: { type: 'object', properties: { ipA: { type: 'string' }, ipB: { type: 'string' } }, required: ['ipA', 'ipB'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: async (input: { ipA: string; ipB: string }) => { if (!input || typeof input.ipA !== 'string' || typeof input.ipB !== 'string' || !input.ipA.trim() || !input.ipB.trim()) throw new Error('Two IP addresses are required.'); setTab('paths'); setIpA(input.ipA); setIpB(input.ipB); return await queryPaths(input.ipA, input.ipB) ?? { error: 'Query failed; see the visible error.' }; } });
    register({ name: 'expand_network_group', description: 'Select and expand an existing network cluster to browse all AS nodes through data tiles.', inputSchema: { type: 'object', properties: { groupId: { type: 'string' } }, required: ['groupId'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: async (input: { groupId: string }) => { const overview = snapshot ?? await fetch('/data/explorer/overview.json').then(r => r.json()) as Snapshot; const group = overview.groups.find(g => g.id === input?.groupId); if (!group) throw new Error('Unknown group ID.'); setSnapshot(overview); setTab('topology'); requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('atlas:open-group', { detail: group.id }))); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ groupId: group.id, label: group.label, asnCount: group.asnCount })))); } });
    return () => controller.abort();
  }, [queryPaths, snapshot]);

  return <div className="app-root">
    <header className="site-header"><div className="header-inner"><button className="brand" onClick={() => { window.location.href = '/'; }} aria-label="AS Atlas 首页"><span className="brand-symbol"><Network size={22}/></span><span>AS<span className="brand-light"> Atlas</span></span><span className="beta-badge">BETA</span></button><nav className="main-nav" aria-label="主导航"><a href="/" aria-current={tab === 'topology' ? 'page' : undefined}><Globe2 size={17}/>全球拓扑</a><a href="/paths" aria-current={tab === 'paths' ? 'page' : undefined}><GitBranch size={17}/>路径对比</a></nav><div className="header-actions"><button className="source-link" onClick={() => setSourceOpen(true)}><Database size={16}/><span>数据来源</span></button><span className="header-divider"/><span className="header-note">Internet, connected.</span></div></div></header>
    <main className="main-shell">
      {tab === 'topology' && <div className="view-content"><section className="page-heading"><div><div className="eyebrow">GLOBAL NETWORK EXPLORER</div><h1>全球网络，一图展开<span className="heading-period">.</span></h1><p>从聚合网络簇到自治系统，探索互联网如何相连。</p></div><div className="snapshot-badge"><span className="snapshot-icon"><Database size={17}/></span><div><strong>CAIDA 网络快照</strong><span>{snapshot ? snapshot.meta.date : '正在读取快照'}<span className="badge-separator">/</span>非实时</span></div></div></section>
      <div className="stats-row"><div className="stat"><span className="stat-icon blue"><Network size={20}/></span><div><span>自治系统</span><strong>{number(snapshot?.meta.totalAS)}<small>AS</small></strong></div></div><div className="stat"><span className="stat-icon teal"><GitBranch size={20}/></span><div><span>AS 关系连接</span><strong>{number(snapshot?.meta.totalLinks)}<small>条</small></strong></div></div><div className="stat"><span className="stat-icon purple"><Layers3 size={20}/></span><div><span>聚合网络簇</span><strong>{snapshot?.groups.length ?? '—'}<small>组</small></strong></div></div><div className="stats-caption"><span className="mini-nodes"><i/><i/><i/></span><span>复杂的网络，清晰的层次</span></div></div>
      {snapshot ? <MapExplorer snapshot={snapshot}/> : <div className="canvas-loading">{dataError ? <><p>{dataError}</p><button className="button secondary" onClick={fetchSnapshot}>重新加载</button></> : <><Loader2 className="spin"/><p>正在加载全球拓扑…</p></>}</div>}
      <div className="below-canvas"><p><ShieldCheck size={15}/>网络簇按连接关系聚合，名称取自核心网络，不表示这些 AS 属于同一公司。</p><button onClick={() => setSourceOpen(true)}>了解数据与方法 <ArrowUpRight size={14}/></button></div></div>}
      {tab === 'paths' && <div className="view-content"><section className="page-heading"><div><div className="eyebrow">BGP PATH COMPARISON</div><h1>两个目标，在哪分路<span className="heading-period">.</span></h1><p>选择同一个第三方视角，查看两条路径共同经过和分别经过的网络。</p></div><div className="snapshot-badge"><span className="snapshot-icon"><Activity size={18}/></span><div><strong>{bgpMetadata?.collector.location ?? '亚洲 BGP 路径库'}</strong><span>每日快照<span className="badge-separator">/</span>{bgpMetadata ? new Date(bgpMetadata.dataTime).toLocaleDateString('zh-CN') : '等待数据'}</span></div></div></section><div className="paths-layout"><aside className="path-form-card"><div className="sidebar-heading"><h2>路径查询</h2><GitBranch size={18}/></div><form onSubmit={e => { e.preventDefault(); queryPaths(); }}><label className="ip-label"><span><i className="ip-dot a"/>目标 IP A</span><input value={ipA} onChange={e => setIpA(e.target.value)} placeholder="例如 1.1.1.1" autoCapitalize="off" autoCorrect="off" spellCheck={false} required/></label><label className="ip-label"><span><i className="ip-dot b"/>目标 IP B</span><input value={ipB} onChange={e => setIpB(e.target.value)} placeholder="例如 8.8.8.8" autoCapitalize="off" autoCorrect="off" spellCheck={false} required/></label><button className="button primary query-button" disabled={loading} type="submit">{loading ? <Loader2 size={17} className="spin"/> : <GitBranch size={17}/>} {loading ? '正在查询路径…' : '对比路径'}{!loading && <ArrowRight size={17}/>}</button></form><div className="form-divider"/><div className="form-note"><ShieldCheck size={18}/><p>支持 IPv4 和 IPv6。显示公开 BGP 观测路径，不是两个 IP 之间的 traceroute。</p></div>{results && <div className="query-summary"><div><span>IP A 观测路由</span><strong>{results[0].routes.length}</strong></div><div><span>IP B 观测路由</span><strong>{results[1].routes.length}</strong></div><div><span>共同观测点</span><strong>{observers.length}</strong></div><p>快照时间 {results[0].dataTime ? new Date(results[0].dataTime).toLocaleString('zh-CN') : '未知'}</p></div>}</aside><section className="path-result-card"><div className="canvas-toolbar"><div className="canvas-title"><span className="title-marker"/><strong>路径如何分开</strong></div>{bgpMetadata && <div className="path-observer-control"><span>观测视角</span><Select value={bgpPeer} onValueChange={value => { setBGPPeer(value); if (hasQueried) queryPaths(ipA, ipB, value); }}><SelectTrigger className="observer-select" aria-label="切换第三方观测视角"><SelectValue/></SelectTrigger><SelectContent>{bgpMetadata.peers.map(peer => <SelectItem key={peer.id} value={peer.id}>AS{peer.asn} · IPv{(Array.isArray(peer.families) ? peer.families : Object.keys(peer.families)).join('/')} · {peer.address}</SelectItem>)}</SelectContent></Select></div>}</div>{loading ? <div className="path-empty"><div className="empty-orbit"><Loader2 size={35} className="spin"/></div><h3>正在读取快照路径</h3><p>两条路径使用同一份快照和同一个观测视角。</p></div> : pathError ? <div className="path-empty error-state" role="alert"><div className="empty-orbit"><Activity size={32}/></div><h3>暂时无法显示路径</h3><p>{pathError}</p><button className="button secondary" onClick={() => queryPaths()}><RefreshCw size={16}/>重新查询</button></div> : routeA && routeB ? <PathDiagram a={routeA} b={routeB} ipA={results![0].ip} ipB={results![1].ip} fetchedAt={results![0].fetchedAt}/> : results ? <div className="path-empty"><div className="empty-orbit"><Search size={32}/></div><h3>没有共同的观测点</h3><p>{results.some(r => r.status === 'missing_family') ? '当前观测视角未收录其中一种 IP 协议。请选择其他视角。' : results.some(r => r.status === 'unsupported_path') ? '至少一条观测包含 AS 集合等非线性路径，无法画成单一路径。' : '当前快照没有同时观测到这两个目标的可用路径。'}<br/>没有观测数据不代表网络不通。</p></div> : <div className="path-empty"><div className="empty-paths"><span className="empty-start"><Activity size={24}/></span><div className="empty-branches"><span>A</span><span>B</span></div></div><h3>从同一个起点，看两条路径</h3><p>填写两个目标 IP，比较沿途的自治系统，<br/>发现它们共享的网络节点。</p><span className="empty-label">DAILY SNAPSHOT · PUBLIC BGP OBSERVATIONS</span></div>}</section></div></div>}
    </main><footer className="site-footer"><span><Network size={15}/>AS Atlas<span className="footer-separator">/</span>连接，可见。</span><span>数据：CAIDA · RouteViews <span className="footer-separator">/</span><button onClick={() => setSourceOpen(true)}>来源与说明 <ArrowUpRight size={12}/></button></span></footer>
    <Dialog open={sourceOpen} onOpenChange={setSourceOpen}><DialogContent className="source-dialog"><DialogHeader><DialogTitle>数据来源与说明</DialogTitle><DialogDescription>拓扑快照和路径查询使用不同的数据源与时间范围。</DialogDescription></DialogHeader><div className="source-section"><h3>全球拓扑 · CAIDA</h3><p>由 AS Relationships 与 AS-to-Organization 数据构建。关系类型是公开观测基础上的推断，不表示物理链路或带宽。</p><p>{snapshot?.meta.groupingZh ?? '选择连接度最高的组织作为核心，将其他 AS 按图上的最近连接距离归入网络簇。'} 网络簇可能包含多个组织，名称仅代表核心网络。</p><a href="https://www.caida.org/catalog/datasets/as-relationships/" target="_blank" rel="noreferrer">CAIDA AS Relationships <ArrowUpRight size={14}/></a><a href="https://www.caida.org/catalog/datasets/as-organizations/" target="_blank" rel="noreferrer">CAIDA AS-to-Organization Mapping <ArrowUpRight size={14}/></a><p className="source-citation">The CAIDA AS Relationships Dataset · {snapshot?.meta.date ?? '当前快照'}<br/>The CAIDA AS to Organization Mapping Dataset</p></div><div className="source-section"><h3>路径查询 · RouteViews 每日快照</h3><p>数据来自香港 HKIX 的公开 BGP 采集器。离线解析后保存在自有路径库中，查询时读取已发布快照。两条路径使用同一个 Peer；它们不是两个 IP 之间的实际往返链路。连续重复的 AS 在图中合并，非线性 AS 集合不画成单一路径。</p><p>香港采集器不代表中国大陆路由视角。数据时间以查询返回的快照时间为准；更新失败时继续提供上一份成功快照。</p><a href="https://archive.routeviews.org/hkix.hkg/bgpdata/" target="_blank" rel="noreferrer">RouteViews HKIX 数据目录 <ArrowUpRight size={14}/></a></div><div className="source-section"><h3>界面参考</h3><a href="https://github.com/thanejoss/webapps" target="_blank" rel="noreferrer">thanejoss / webapps <ArrowUpRight size={14}/></a></div></DialogContent></Dialog>
  </div>;
}
