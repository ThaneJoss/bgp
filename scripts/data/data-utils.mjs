import { createReadStream } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';
import { bunzip } from '../../lib/bgp/streams.mjs';

export const defaultDataDirectory = dirname(fileURLToPath(import.meta.url));

export function dataDirectory(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { 'data-dir': { type: 'string', default: defaultDataDirectory } } });
  return resolve(values['data-dir']);
}

/** Decode incrementally with the same block/CRC checks as browser imports. */
export async function* readLines(path) {
  const file = createReadStream(path);
  const chunks = path.endsWith('.bz2') ? bunzip(file)
    : path.endsWith('.gz') ? file.pipe(createGunzip()) : file;
  // pipe() does not forward input errors to a gunzip async iterator itself.
  if (path.endsWith('.gz')) file.on('error', error => chunks.destroy(error));
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  try {
    for await (const chunk of chunks) {
      pending += decoder.decode(chunk, { stream: true });
      let start = 0, end;
      while ((end = pending.indexOf('\n', start)) !== -1) {
        yield pending.slice(start, end).replace(/\r$/, '');
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    pending += decoder.decode();
    if (pending) yield pending.replace(/\r$/, '');
  } finally {
    file.destroy();
    if (chunks !== file) chunks.destroy?.();
  }
}

export async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function writeJson(path, value, pretty = false) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, pretty ? 2 : undefined));
}

/** A specified PRNG, not Python's Random or NumPy's generator. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function relationshipRow(line) {
  const fields = line.trim().split('|');
  if (fields.length < 3 || !fields.slice(0, 2).every(v => /^\d+$/.test(v)) || !['0', '-1'].includes(fields[2])) {
    throw new Error(`Invalid relationship row: ${line}`);
  }
  const [a, b, relationship] = fields.slice(0, 3).map(Number);
  if (![a, b].every(v => Number.isInteger(v) && v > 0 && v <= 0xffffffff)) throw new Error(`Invalid ASN: ${line}`);
  return [a, b, relationship];
}
