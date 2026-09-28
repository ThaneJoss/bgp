import { MAX_DOWNLOAD_BYTES, snapshotSource } from '../lib/bgp/source.mjs';

// RouteViews only grants CORS to its own explorer. Relay raw bytes on demand;
// do not parse, cache, persist, or accept arbitrary upstream URLs.
export async function downloadBGP(request, fetchUpstream = fetch) {
  const json = (error, status) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
  if (request.method !== 'GET') return json('仅支持 GET。', 405);
  let source;
  try { source = snapshotSource(new URL(request.url).searchParams.get('date')); }
  catch (error) { return json(error.message, 400); }
  try {
    const response = await fetchUpstream(source.url, {
      signal: request.signal, redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/octet-stream' },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return json(response.status === 404 ? '该日期的 00:00 UTC 快照尚不存在，请选择更早的日期。' : 'RouteViews 暂时无法下载，请稍后重试或导入本地文件。', response.status === 404 ? 404 : 502);
    }
    const size = Number(response.headers.get('content-length'));
    if (size > MAX_DOWNLOAD_BYTES) {
      await response.body.cancel();
      return json('原始文件超过 1 GiB 限制。', 413);
    }
    const headers = new Headers({
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${source.filename}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    if (size > 0) headers.set('Content-Length', String(size));
    return new Response(response.body, { headers });
  } catch {
    return json('下载连接失败，请重试，或下载原始文件后在浏览器导入。', 502);
  }
}
