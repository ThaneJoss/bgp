'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, FileUp, Loader2, X } from 'lucide-react';
import { cancelBGPDownload, loadBGPData, type BGPMetadata, type BGPProgress } from '@/lib/bgp-client';
import { defaultSnapshotDate, snapshotSource } from '@/lib/bgp/source.mjs';

const size = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;

export default function BGPDataControls({ metadata, onReady, onBusy }: {
  metadata: BGPMetadata | null;
  onReady: (metadata: BGPMetadata) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [date, setDate] = useState(defaultSnapshotDate);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<BGPProgress | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancelBGPDownload(); onBusy(false); };
  }, [onBusy]);
  let sourceUrl = '';
  try { sourceUrl = snapshotSource(date).url; } catch {}

  const acquire = async (file?: File) => {
    setError(''); setMessage(''); setProgress(null); setBusy(true); onBusy(true);
    try {
      const result = await loadBGPData({ date, file, onProgress: update => { if (mounted.current) setProgress(update); } });
      if (!mounted.current) return;
      onReady(result);
      setMessage(`解析完成：${result.routeCount.toLocaleString('zh-CN')} 条路由，${result.peers.length} 个观测 session。`);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof Error && error.name === 'AbortError') setMessage('已取消，可重新获取。');
      else setError(error instanceof Error ? error.message : '获取数据失败，请重试。');
    } finally {
      if (mounted.current) { setBusy(false); onBusy(false); }
    }
  };

  return <section className="bgp-data-card" aria-label="浏览器获取 BGP 数据">
    <div className="bgp-data-heading"><div><h2>获取 BGP 数据</h2><p>点击后下载 RouteViews 原始文件，由当前浏览器解压、解析。刷新页面后需重新获取。</p></div><span className="local-data-badge">浏览器本地处理</span></div>
    <div className="bgp-data-actions">
      <label className="snapshot-date">快照日期（UTC 00:00）<input aria-label="快照日期（UTC）" type="date" min="2000-01-01" max={new Date().toISOString().slice(0, 10)} value={date} disabled={busy} onChange={event => setDate(event.target.value)}/></label>
      <button className="button primary" disabled={busy || !sourceUrl} onClick={() => acquire()}>{busy ? <Loader2 size={17} className="spin"/> : <Download size={17}/>} {busy ? '正在获取并解析…' : metadata ? '重新获取数据' : '获取数据'}</button>
      {busy ? <button className="button secondary" onClick={cancelBGPDownload}><X size={16}/>取消</button> : <button className="button secondary" onClick={() => input.current?.click()}><FileUp size={16}/>导入本地文件</button>}
      <input ref={input} className="file-input" aria-label="导入 MRT 文件" type="file" accept=".bz2,.gz,.mrt,.rib" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) acquire(file); }}/>
      {sourceUrl && <a className="raw-data-link" href={sourceUrl} target="_blank" rel="noreferrer">下载原始文件 ↗</a>}
    </div>
    {busy && <div className="bgp-load-progress" role="status"><progress aria-label="数据下载进度" max={100} value={progress?.total ? Math.min(99, progress.downloaded / progress.total * 100) : undefined}/><p>{progress ? `已读取 ${size(progress.downloaded)}${progress.total ? ` / ${size(progress.total)}` : ''} · 已解析 ${progress.records.toLocaleString('zh-CN')} 条记录 · 已收录 ${progress.routes.toLocaleString('zh-CN')} 条路由` : '正在连接数据源…'}<br/>文件较大，解析需要一些时间，请保持页面打开。</p></div>}
    {message && <p className="bgp-data-message" role="status">{message}</p>}
    {error && <p className="bgp-data-error" role="alert">{error} {metadata ? '当前已加载的数据仍可查询。' : '也可下载 HKIX 原始文件，再使用“导入本地文件”。'}</p>}
    {!busy && metadata && <p className="bgp-data-summary">当前数据：{new Date(metadata.dataTime).toLocaleString('zh-CN')} · {metadata.routeCount.toLocaleString('zh-CN')} 条路由 · {metadata.source}</p>}
    {!busy && !metadata && <p className="bgp-data-summary">尚未加载路径数据。支持 HKIX MRT、.bz2、.gz 文件；导入文件不会上传。</p>}
  </section>;
}
