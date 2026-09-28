import { downloadBGP } from './bgp-download.mjs';

export function createWorker({ website, download = downloadBGP }) {
  return {
    fetch(request, env, ctx) {
      const { pathname } = new URL(request.url);
      if (pathname === '/api/bgp/download') return download(request);
      if (pathname === '/api/bgp' || pathname.startsWith('/api/bgp/') || pathname === '/_ingest' || pathname.startsWith('/_ingest/')) {
        return Response.json({ error: '服务端路径库和上传入口已停用。请在网页获取数据后使用浏览器本地查询。' }, {
          status: 410, headers: { 'Cache-Control': 'no-store' },
        });
      }
      return website.fetch(request, env, ctx);
    },
  };
}
