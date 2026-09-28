import { ByteReader, bunzip, streamChunks } from './streams.mjs';
import { parseMRT } from './mrt.mjs';
import { MAX_DOWNLOAD_BYTES } from './source.mjs';

export async function loadRoutingTable(stream, source, onProgress = () => {}) {
  let downloaded = 0, decompressed = 0;
  const counted = async function* () {
    for await (const chunk of streamChunks(stream)) {
      downloaded += chunk.length;
      if (downloaded > MAX_DOWNLOAD_BYTES) throw new Error('原始文件超过 1 GiB 下载限制。');
      onProgress({ downloaded });
      yield chunk;
    }
  };
  const input = new ByteReader(counted());
  try {
    if (!await input.ensure(4)) throw new Error('数据文件过短。');
    const magic = input.data.subarray(input.offset, input.offset + 4);
    const chunks = async function* () {
      while (await input.ensure(1)) yield await input.take(input.available);
    };
    let decoded;
    if (magic[0] === 66 && magic[1] === 90 && magic[2] === 104) decoded = bunzip(chunks());
    else if (magic[0] === 31 && magic[1] === 139) {
      if (typeof DecompressionStream === 'undefined') throw new Error('此浏览器不支持 gzip，请导入 .bz2 或未压缩的 MRT 文件。');
      const iterator = chunks();
      const compressed = new ReadableStream({
        async pull(controller) {
          try {
            const next = await iterator.next();
            if (next.done) controller.close(); else controller.enqueue(next.value);
          } catch (error) { controller.error(error); }
        },
        async cancel() { await iterator.return(); },
      });
      decoded = streamChunks(compressed.pipeThrough(new DecompressionStream('gzip')));
    } else decoded = chunks();
    const bounded = async function* () {
      for await (const chunk of decoded) {
        decompressed += chunk.length;
        if (decompressed > 8 * 1024 ** 3) throw new Error('解压后的文件超过 8 GiB 限制。');
        yield chunk;
      }
    };
    return await parseMRT(bounded(), source, progress => onProgress({ ...progress, downloaded, decompressed }));
  } finally { await input.close(); }
}
