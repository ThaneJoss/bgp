export async function GET() {
  return Response.json({ error: '路径查询已迁移至自有快照服务，请使用 /api/bgp/compare。' }, {
    status: 410, headers: { 'Cache-Control': 'no-store' },
  });
}
