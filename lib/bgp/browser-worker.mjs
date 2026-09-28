import { loadRoutingTable } from './load.mjs';
import { MAX_DOWNLOAD_BYTES, snapshotSource } from './source.mjs';

let table;
self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'load') {
      let stream, source;
      const progress = { downloaded: 0, decompressed: 0, records: 0, routes: 0, total: 0 };
      let lastProgress = 0;
      if (data.file) {
        if (data.file.size > MAX_DOWNLOAD_BYTES) throw new Error('文件超过 1 GiB 限制。');
        stream = data.file.stream();
        source = { label: `本地 MRT · ${data.file.name}` };
        progress.total = data.file.size;
      } else {
        source = snapshotSource(data.date);
        const response = await fetch(`/api/bgp/download?date=${encodeURIComponent(data.date)}`, {
          cache: 'no-store', signal: AbortSignal.timeout(20 * 60 * 1000),
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || `下载失败（HTTP ${response.status}）。可下载原始文件后导入。`);
        }
        if (!response.body) throw new Error('此浏览器不支持流式下载，请导入本地文件。');
        progress.total = Number(response.headers.get('content-length')) || 0;
        if (progress.total > MAX_DOWNLOAD_BYTES) {
          await response.body.cancel();
          throw new Error('文件超过 1 GiB 限制。');
        }
        stream = response.body;
      }
      table = await loadRoutingTable(stream, source, update => {
        Object.assign(progress, update);
        if (performance.now() - lastProgress > 150) {
          self.postMessage({ id, type: 'progress', progress });
          lastProgress = performance.now();
        }
      });
      self.postMessage({ id, type: 'ready', metadata: table.metadata });
    } else if (type === 'compare') {
      if (!table) throw new Error('请先获取数据。');
      self.postMessage({ id, type: 'result', results: [table.lookup(data.a, data.peer), table.lookup(data.b, data.peer)] });
    }
  } catch (error) {
    self.postMessage({ id, type: 'error', error: error instanceof Error ? error.message : '数据处理失败。' });
  }
};
