import bzip2 from './vendor/bzip2.mjs';

/** Pull one chunk at a time and close the network/file stream on any failure. */
export async function* streamChunks(stream) {
  const reader = stream.getReader();
  let ended = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { ended = true; return; }
      if (value.length) yield value;
    }
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class ByteReader {
  constructor(chunks) {
    this.iterator = chunks[Symbol.asyncIterator]();
    this.data = new Uint8Array();
    this.offset = 0;
    this.done = false;
  }
  get available() { return this.data.length - this.offset; }
  async ensure(size) {
    if (this.available >= size) return true;
    const parts = [this.data.subarray(this.offset)];
    let total = this.available;
    while (total < size && !this.done) {
      const next = await this.iterator.next();
      this.done = Boolean(next.done);
      if (!next.done) { parts.push(next.value); total += next.value.length; }
    }
    this.data = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { this.data.set(part, offset); offset += part.length; }
    this.offset = 0;
    return total >= size;
  }
  async take(size) {
    if (!await this.ensure(size)) throw new Error('数据文件被截断，请重新获取完整文件。');
    const data = this.data.subarray(this.offset, this.offset + size);
    this.offset += size;
    return data;
  }
  async close() { await this.iterator.return?.(); }
}

/** Decode and CRC-check a block before releasing it; never retain the whole RIB. */
export async function* bunzip(chunks) {
  const input = new ByteReader(chunks);
  const decoder = Object.create(bzip2);
  let bit = 0;
  const bits = count => {
    if (count === null) {
      if (bit) { bit = 0; input.offset++; }
      return 0;
    }
    let value = 0;
    while (count > 0) {
      if (!input.available) throw new Error('bzip2 文件被截断。');
      const take = Math.min(count, 8 - bit);
      value = (value << take) | ((input.data[input.offset] >> (8 - bit - take)) & ((1 << take) - 1));
      bit += take;
      count -= take;
      if (bit === 8) { bit = 0; input.offset++; }
    }
    return value;
  };
  try {
    let streams = 0;
    while (await input.ensure(1)) {
      if (!await input.ensure(4)) throw new Error('bzip2 文件头被截断。');
      const size = decoder.header(bits) * 100000;
      const workspace = new Int32Array(size);
      let crc = 0;
      do {
        // More than the worst-case compressed block, plus headers. EOF is
        // checked by bits(), including the final stream CRC and padding.
        await input.ensure(size * 2 + 65536);
        const output = [];
        let chunk = new Uint8Array(65536), used = 0, total = 0;
        crc = decoder.decompress(bits, byte => {
          if (++total > 64 * 1024 ** 2) throw new Error('bzip2 解压块超过内存限制。');
          chunk[used++] = byte;
          if (used === chunk.length) { output.push(chunk); chunk = new Uint8Array(65536); used = 0; }
        }, workspace, size, crc);
        if (used) output.push(chunk.subarray(0, used));
        for (const part of output) yield part;
      } while (crc !== null);
      streams++;
    }
    if (!streams) throw new Error('空 bzip2 文件。');
  } finally { await input.close(); }
}
