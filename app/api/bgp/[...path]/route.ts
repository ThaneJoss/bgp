export async function GET() {
  return Response.json({ error: '服务端路径库已停用。请在网页获取数据后使用浏览器本地查询。' }, {
    status: 410, headers: { 'Cache-Control': 'no-store' },
  });
}
