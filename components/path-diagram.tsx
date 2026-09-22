'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUpRight, GitBranch, Network, Radio } from 'lucide-react';

export type BgpRoute = { rrc: string; location: string; peer: string; prefix: string; path: number[]; observedAt: string };
type NetworkInfo = { name: string; organization?: string; country?: string };
type NameShard = Record<string, NetworkInfo>;
const nameCache = new Map<number, Promise<NameShard>>();

export function splitPaths(a: number[], b: number[]) {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  const rightSet = new Set(b.slice(shared));
  return {
    trunk: a.slice(0, shared),
    branches: [a.slice(shared), b.slice(shared)],
    laterCommon: new Set(a.slice(shared).filter(asn => rightSet.has(asn))),
  };
}

function loadNames(bucket: number) {
  if (!nameCache.has(bucket)) {
    nameCache.set(bucket, fetch(`/data/explorer/names/${bucket}.json`, { signal: AbortSignal.timeout(12000) })
      .then(response => { if (!response.ok) throw new Error('Names unavailable'); return response.json() as Promise<NameShard>; })
      .catch(error => { nameCache.delete(bucket); throw error; }));
  }
  return nameCache.get(bucket)!;
}

export default function PathDiagram({ a, b, ipA, ipB, fetchedAt, initialNames = {} }: {
  a: BgpRoute; b: BgpRoute; ipA: string; ipB: string; fetchedAt: string; initialNames?: NameShard;
}) {
  const [names, setNames] = useState<NameShard>(initialNames);
  const [namesStatus, setNamesStatus] = useState<'loading' | 'ready' | 'partial'>('loading');
  const paths = useMemo(() => splitPaths(a.path, b.path), [a.path, b.path]);
  const buckets = useMemo(() => [...new Set([...a.path, ...b.path].map(asn => asn % 256))].sort((x, y) => x - y), [a.path, b.path]);
  useEffect(() => {
    let active = true;
    setNamesStatus('loading');
    Promise.allSettled(buckets.map(loadNames)).then(results => {
      if (!active) return;
      const combined: NameShard = {};
      for (const result of results) if (result.status === 'fulfilled') Object.assign(combined, result.value);
      setNames(previous => ({ ...previous, ...combined }));
      setNamesStatus(results.some(result => result.status === 'rejected') ? 'partial' : 'ready');
    });
    return () => { active = false; };
  }, [buckets]);

  const titleFor = (asn: number) => {
    const info = names[String(asn)];
    return info?.organization && info.organization !== 'Unknown organization' ? info.organization : info?.name || (namesStatus === 'loading' ? '正在读取网络名称…' : '未收录网络名称');
  };
  const node = (asn: number, tone: string, note?: string) => <a className={`path-network path-network-${tone}`} href={`/?asn=${asn}`} aria-label={`${titleFor(asn)}，AS${asn}，在地图中查看`}>
    <span className="path-network-icon"><Network size={19}/></span>
    <span className="path-network-copy"><strong>{titleFor(asn)}</strong><span>AS{asn}{note && <small>{note}</small>}</span></span>
    <ArrowUpRight className="path-network-open" size={15}/>
  </a>;
  const same = !paths.branches[0].length && !paths.branches[1].length;
  const oneEnds = paths.trunk.length > 0 && paths.branches.some(branch => !branch.length);
  const summary = same ? '两个目标的 AS 路径相同。'
    : oneEnds ? '两条路径先经过相同的网络，其中一条在共同网络内结束。'
    : paths.trunk.length ? `先共同经过 ${paths.trunk.length} 个网络，再分别前往两个目标。`
    : '同一个观测点，提供了两条不同的 AS 路径。';
  const collected = new Date(fetchedAt);
  const timestamp = Number.isNaN(collected.getTime()) ? fetchedAt : `${collected.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return <div className="path-comparison">
    <div className="path-reading-guide"><GitBranch size={20}/><div><strong>{summary}</strong><p>{paths.trunk.length ? '从上往下读：共同网络在上方，两个目标在下方。' : '左右两路分别从各自的首个网络，通往下方目标。'}</p></div></div>
    <div className="path-perspective"><Radio size={17}/><span><strong>记录来源</strong> {a.rrc.toUpperCase()} · {a.location}</span><span>提供路由的 Peer：<code>{a.peer}</code></span></div>
    <div className="path-tree" aria-label="从共同观测视角到两个目标的 BGP 路径">
      {paths.trunk.length > 0 ? <div className="path-trunk"><div className="path-section-label">{paths.trunk.length === 1 ? '共同经过的网络' : `共同经过的 ${paths.trunk.length} 个网络`}</div>{paths.trunk.map((asn, i) => <div key={`${asn}-${i}`} className="path-trunk-step">{i > 0 && <div className="path-down-line"><ArrowDown size={16}/></div>}{node(asn, 'shared', i === 0 ? '路径起点' : undefined)}</div>)}</div> : <div className="path-no-trunk">没有相同的起始 AS 序列；下方分别保留两条原始观测路径。</div>}
      {paths.trunk.length > 0 && <div className={`path-fork ${same ? 'path-fork-same' : ''}`} aria-hidden="true"><span/><span/><span/></div>}
      <div className="path-branches">{[a, b].map((route, side) => <div className={`path-branch path-branch-${side}`} key={side}>
        <div className="path-branch-heading"><span className="path-target-letter">{side ? 'B' : 'A'}</span><span>前往 <strong>{side ? ipB : ipA}</strong></span></div>
        <div className="path-branch-nodes">{paths.branches[side].map((asn, i) => <div key={`${asn}-${i}`} className="path-branch-step">{i > 0 && <div className="path-down-line"><ArrowDown size={16}/></div>}{node(asn, side ? 'b' : 'a', paths.laterCommon.has(asn) ? '两条路径均经过' : undefined)}</div>)}</div>
        {!paths.branches[side].length && <p className="path-within-network">目标所在网络已包含在上方共同路径中。</p>}
        <div className="path-down-line path-target-line"><ArrowDown size={16}/></div>
        <div className="path-destination"><span>目标 IP {side ? 'B' : 'A'}</span><strong>{side ? ipB : ipA}</strong><small>所属前缀 {route.prefix}</small><span className="path-hop-count">路径包含 {route.path.length} 个 AS · {Math.max(route.path.length - 1, 0)} 次 AS 跳转</span></div>
      </div>)}</div>
    </div>
    <div className="path-explanation"><strong>这里比较的是什么？</strong><p>同一个第三方网络到 IP A、IP B 的 BGP 观测路径。它不表示 A 直接访问 B 的实际通信路线，也不是延迟测量。</p><div><span>路径获取：{timestamp}</span><span>网络名称来自 CAIDA 快照；点击网络可在拓扑中查看。</span></div>{namesStatus === 'partial' && <p role="status">部分网络名称暂未加载，AS 编号与路径不受影响。</p>}</div>
  </div>;
}
