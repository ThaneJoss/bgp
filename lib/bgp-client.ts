export type BGPRoute = { rrc: string; location: string; peer: string; prefix: string; path: number[]; observedAt: string };
export type BGPPathResult = {
  ip: string; fetchedAt: string; dataTime: string | null; source: string; snapshotId: string;
  status: 'ok' | 'not_observed' | 'unsupported_path' | 'missing_family'; routes: BGPRoute[];
};
export type BGPMetadata = {
  snapshotId: string; dataTime: string; source?: string; routeCount: number;
  collector: { id: string; location: string }; defaultPeer: string;
  peers: { id: string; asn: number; address: string; families: number[]; prefixCounts: Record<string, number> }[];
};
export type BGPProgress = { downloaded: number; decompressed: number; records: number; routes: number; total: number };
type WorkerMessage = { id: number; type: string; metadata: BGPMetadata; progress: BGPProgress; results: [BGPPathResult, BGPPathResult]; error?: string };

let activeWorker: Worker | undefined;
let metadata: BGPMetadata | null = null;
let sequence = 0;
let cancelPending: (() => void) | undefined;
const queries = new Map<number, { resolve: (results: [BGPPathResult, BGPPathResult]) => void; reject: (error: Error) => void }>();

export function getBGPMetadata(): BGPMetadata | null { return metadata; }
export function cancelBGPDownload() { cancelPending?.(); }

export function loadBGPData(options: { date: string; file?: File; onProgress: (progress: BGPProgress) => void }): Promise<BGPMetadata> {
  if (cancelPending) return Promise.reject(new Error('已有数据正在获取，请等待或取消。'));
  const worker = new Worker(new URL('./bgp/browser-worker.mjs', import.meta.url), { type: 'module' });
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    let loaded = false, closed = false;
    const fail = (error: Error) => {
      if (closed) return;
      closed = true;
      worker.terminate();
      if (!loaded) { cancelPending = undefined; reject(error); }
      else if (worker === activeWorker) {
        activeWorker = undefined; metadata = null;
        for (const pending of queries.values()) pending.reject(error);
        queries.clear();
      }
    };
    cancelPending = () => fail(new DOMException('已取消获取数据。', 'AbortError'));
    worker.onerror = () => fail(new Error('浏览器数据处理线程失败，请重新获取数据或尝试桌面浏览器。'));
    worker.onmessageerror = () => fail(new Error('无法读取浏览器数据处理结果。'));
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if (closed) return;
      if (!loaded && data.id === id) {
        if (data.type === 'progress') options.onProgress(data.progress);
        else if (data.type === 'error') fail(new Error(data.error || '数据处理失败。'));
        else if (data.type === 'ready') {
          loaded = true;
          cancelPending = undefined;
          activeWorker?.terminate();
          for (const pending of queries.values()) pending.reject(new Error('数据已更新，请重新查询。'));
          queries.clear();
          activeWorker = worker; metadata = data.metadata;
          resolve(data.metadata);
        }
        return;
      }
      const pending = queries.get(data.id);
      if (!pending) return;
      queries.delete(data.id);
      if (data.type === 'error') pending.reject(new Error(data.error || '查询失败。'));
      else pending.resolve(data.results);
    };
    worker.postMessage({ id, type: 'load', date: options.date, file: options.file });
  });
}

export function compareBGPPaths(a: string, b: string, peer: string): Promise<[BGPPathResult, BGPPathResult]> {
  if (!activeWorker || !metadata) return Promise.reject(new Error('请先点击“获取数据”，等待浏览器完成下载和解析。'));
  const worker = activeWorker, id = ++sequence;
  return new Promise((resolve, reject) => {
    queries.set(id, { resolve, reject });
    worker.postMessage({ id, type: 'compare', a: a.trim(), b: b.trim(), peer });
  });
}
