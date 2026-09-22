export type BGPRoute = { rrc: string; location: string; peer: string; prefix: string; path: number[]; observedAt: string };
export type BGPPathResult = {
  ip: string; fetchedAt: string; dataTime: string | null; source: string; snapshotId: string;
  status: 'ok' | 'not_observed' | 'unsupported_path' | 'missing_family'; routes: BGPRoute[];
};
export type BGPMetadata = {
  snapshotId: string; dataTime: string; source?: string;
  collector: { id: string; location: string }; defaultPeer: string;
  peers: { id: string; asn: number; address: string; label?: string; families: Record<string, unknown> | number[] }[];
};

let basePromise: Promise<string> | undefined;
async function apiBase(): Promise<string> {
  basePromise ??= fetch('/bgp-service.json', { cache: 'no-cache' }).then(async response => {
    if (!response.ok) throw new Error('路径服务配置暂时无法读取。');
    const config = await response.json() as { apiBase?: unknown };
    if (typeof config.apiBase !== 'string') throw new Error('路径服务地址配置无效。');
    const base = config.apiBase.replace(/\/$/, '');
    if (base !== '') {
      const url = new URL(base);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('路径服务必须使用 HTTPS 服务地址。');
      }
    }
    return base;
  }).catch(error => { basePromise = undefined; throw error; });
  return basePromise;
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${await apiBase()}${path}`, {
    signal: AbortSignal.timeout(25000), cache: 'no-store', headers: { Accept: 'application/json' },
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('路径服务尚未接通，请检查查询服务地址。');
  const data = await response.json() as T & { error?: string };
  if (!response.ok || data.error) throw new Error(data.error || '路径库暂时不可用，请稍后重试。');
  return data;
}

export function getBGPMetadata(): Promise<BGPMetadata> {
  return request<BGPMetadata>('/api/bgp/manifest');
}

export async function compareBGPPaths(a: string, b: string, peer: string) {
  const query = new URLSearchParams({ a: a.trim(), b: b.trim(), peer });
  const data = await request<{ snapshotId: string; results: [BGPPathResult, BGPPathResult] }>(`/api/bgp/compare?${query}`);
  if (!Array.isArray(data.results) || data.results.length !== 2 || data.results.some(result => result.snapshotId !== data.snapshotId)) {
    throw new Error('两条路径的快照版本不一致，请重试。');
  }
  // Preserve raw prepends in storage/API; collapse consecutive repeats only for the diagram.
  return data.results.map(result => ({ ...result, routes: result.routes.map(route => ({
    ...route, path: route.path.filter((asn, index, path) => index === 0 || asn !== path[index - 1]),
  })) })) as [BGPPathResult, BGPPathResult];
}
