import { mkdir, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { dataDirectory, writeJson } from './data-utils.mjs';

const sources = [
  ['relationships', 'https://data.caida.org/datasets/as-relationships/serial-1/', /\d{8}\.as-rel\.txt\.bz2/g],
  ['organizations', 'https://data.caida.org/datasets/as-organizations/', /\d{8}\.as-org2info\.txt\.gz/g],
];

export function latestFilename(listing, pattern, today = new Date().toISOString().slice(0, 10).replaceAll('-', '')) {
  const files = [...new Set(listing.match(pattern) ?? [])].filter(name => name.slice(0, 8) <= today).sort();
  if (!files.length) throw new Error('CAIDA listing contains no eligible snapshot');
  return files.at(-1);
}

export async function fetchCaida({ dataDir, fetchImpl = fetch, now = new Date() }) {
  await mkdir(dataDir, { recursive: true });
  const fetchedAt = now.toISOString(), fetchedDate = fetchedAt.slice(0, 10);
  const request = async (url, timeout) => {
    const response = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(`CAIDA HTTP ${response.status}: ${url}`);
    return response;
  };
  // Wait for both downloads even if one fails; never publish partial sources.json.
  const results = await Promise.allSettled(sources.map(async ([key, base, pattern]) => {
    const listing = await (await request(base, 30000)).text();
    await writeFile(join(dataDir, `${key}-index.html`), listing);
    const filename = latestFilename(listing, pattern, fetchedDate.replaceAll('-', ''));
    const url = base + filename, temporary = join(dataDir, `${filename}.part`);
    try {
      const response = await request(url, 45000);
      if (!response.body) throw new Error(`CAIDA returned an empty body: ${url}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      const bytes = (await stat(temporary)).size;
      if (!bytes) throw new Error(`CAIDA returned an empty file: ${url}`);
      await rename(temporary, join(dataDir, filename));
      console.log(key, 'saved', filename, bytes);
      return [key, { url, filename, snapshotDate: `${filename.slice(0, 4)}-${filename.slice(4, 6)}-${filename.slice(6, 8)}`, bytes, fetchedAt, fetchedDate }];
    } finally { await rm(temporary, { force: true }); }
  }));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  const result = Object.fromEntries(results.map(value => value.value));
  await writeJson(join(dataDir, 'sources.json.part'), result, true);
  await rename(join(dataDir, 'sources.json.part'), join(dataDir, 'sources.json'));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await fetchCaida({ dataDir: dataDirectory() });
}
