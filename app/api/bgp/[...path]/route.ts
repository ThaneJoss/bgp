// The unified Worker handles /api/bgp/* before requests reach Vinext.
// Framework-only development still reports that the R2-backed handler is absent.
export async function GET() {
  return Response.json({ error: '离线路径库尚未接通。请先发布首份快照并配置 BGP 查询服务。' }, {
    status: 503, headers: { 'Cache-Control': 'no-store' },
  });
}
