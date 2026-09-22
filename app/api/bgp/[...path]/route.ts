// Route /api/bgp/* directly to the standalone BGP Worker for same-origin hosting.
// This fallback never fetches public BGP APIs.
export async function GET() {
  return Response.json({ error: '离线路径库尚未接通。请先发布首份快照并配置 BGP 查询服务。' }, {
    status: 503, headers: { 'Cache-Control': 'no-store' },
  });
}
