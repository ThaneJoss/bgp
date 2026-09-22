#!/usr/bin/env node
/** Offline synthetic benchmark. No fetch, downloads, deployments, or R2 writes. */
import { performance } from 'node:perf_hooks';
import { handleRequest } from '../../workers/bgp/src/index.mjs';

const RECORD_BYTES = 24;
const PAGE_RECORDS = 1024;
const encoder = new TextEncoder();

function writeAddress(view, offset, address) {
  view.setBigUint64(offset, address >> 64n);
  view.setBigUint64(offset + 8, address & ((1n << 64n) - 1n));
}

function fixture({ pageCount, pathLength, manifestBytes }) {
  const prefix = 'snapshots/20000101T000000Z/';
  const count = pageCount * PAGE_RECORDS;
  const files = new Map();
  const ranges = new Map();
  const inventory = [];
  const families = {};
  const targets = {
    4: [0x01010101n, 0x08080808n],
    6: [0x20014860486000000000000000008888n, 0x26064700470000000000000000001111n],
  };
  for (const family of [4, 6]) {
    const space = 1n << BigInt(family === 4 ? 32 : 128);
    const start = (record) => BigInt(record) * space / BigInt(count);
    const names = {
      index: `p0/v${family}.index.bin`,
      records: `p0/v${family}.records.bin`,
      paths: `p0/v${family}.paths.bin`,
    };
    const index = new Uint8Array(pageCount * RECORD_BYTES);
    const indexView = new DataView(index.buffer);
    for (let page = 0; page < pageCount; page += 1) {
      const offset = page * RECORD_BYTES;
      writeAddress(indexView, offset, start(page * PAGE_RECORDS));
      indexView.setUint32(offset + 16, page * PAGE_RECORDS * RECORD_BYTES);
      indexView.setUint16(offset + 20, PAGE_RECORDS);
    }
    files.set(prefix + names.index, index);
    const paths = new Uint8Array(pathLength * 4);
    const pathsView = new DataView(paths.buffer);
    for (let hop = 0; hop < pathLength; hop += 1) pathsView.setUint32(hop * 4, 64512 + hop);
    files.set(prefix + names.paths, paths);
    const pageNumbers = new Set(targets[family].map((address) => {
      let record = Number(address * BigInt(count) / space);
      // Integer division of generated interval starts can move a boundary back.
      while (record + 1 < count && start(record + 1) <= address) record += 1;
      return Math.floor(record / PAGE_RECORDS);
    }));
    for (const page of pageNumbers) {
      const bytes = new Uint8Array(PAGE_RECORDS * RECORD_BYTES);
      const view = new DataView(bytes.buffer);
      for (let record = 0; record < PAGE_RECORDS; record += 1) {
        const offset = record * RECORD_BYTES;
        writeAddress(view, offset, start(page * PAGE_RECORDS + record));
        view.setUint32(offset + 16, 0);
        view.setUint16(offset + 20, pathLength);
        view.setUint8(offset + 22, 0);
        view.setUint8(offset + 23, 1);
      }
      ranges.set(`${prefix}${names.records}:${page * PAGE_RECORDS * RECORD_BYTES}:${bytes.length}`, bytes);
    }
    families[String(family)] = { ...names, intervalCount: count, indexCount: pageCount };
    for (const [kind, key] of Object.entries(names)) inventory.push({
      key,
      bytes: kind === 'records' ? count * RECORD_BYTES : files.get(prefix + key).length,
      sha256: '0'.repeat(64), // Synthetic metadata; the query does not authenticate hashes.
    });
  }
  const manifest = {
    schemaVersion: 1,
    snapshotId: '20000101T000000Z',
    generatedAt: '2000-01-01T00:00:00Z',
    dataTime: '2000-01-01T00:00:00Z',
    collector: { id: 'synthetic', location: 'Synthetic benchmark', sourceUrl: 'https://example.invalid/no-network' },
    defaultPeer: 'p0',
    peers: [{ id: 'p0', asn: 64512, address: '192.0.2.1', label: 'Synthetic only', families }],
    files: inventory,
    statistics: {},
  };
  manifest.statistics.benchmarkPadding = '';
  manifest.statistics.benchmarkPadding = 'x'.repeat(Math.max(0, manifestBytes - encoder.encode(JSON.stringify(manifest)).length));
  const rawManifest = encoder.encode(JSON.stringify(manifest));
  files.set('latest.json', rawManifest);
  const sizes = new Map(inventory.map((entry) => [prefix + entry.key, entry.bytes]));
  sizes.set('latest.json', rawManifest.length);
  let reads = 0;
  let fetchedBytes = 0;
  const bucket = {
    async get(key, options = {}) {
      reads += 1;
      let bytes;
      if (options.range) {
        const { offset = 0, length } = options.range;
        bytes = ranges.get(`${key}:${offset}:${length}`);
        if (!bytes && files.has(key)) bytes = files.get(key).subarray(offset, length === undefined ? undefined : offset + length);
      } else bytes = files.get(key);
      if (!bytes) throw new Error(`Synthetic fixture does not contain requested object/range: ${key} ${JSON.stringify(options)}`);
      fetchedBytes += bytes.byteLength;
      // A fresh copy mimics body transfer; all source data is already in RAM.
      const response = new Response(bytes.slice());
      return {
        key,
        size: sizes.get(key),
        body: response.body,
        range: options.range,
        arrayBuffer: () => response.arrayBuffer(),
        text: () => response.text(),
        json: () => response.json(),
      };
    },
  };
  return {
    env: { BGP_BUCKET: bucket },
    stats: () => ({ reads, fetchedBytes }),
    reset: () => { reads = 0; fetchedBytes = 0; },
    details: { pageCount, syntheticIntervalsPerFamily: count, indexBytesPerFamily: pageCount * RECORD_BYTES, pageBytes: PAGE_RECORDS * RECORD_BYTES, pathLength, manifestBytes: rawManifest.length },
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

const args = process.argv.slice(2);
let iterations = 500;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] !== '--iterations' || !args[i + 1]) throw new Error('Usage: node scripts/bgp/bench-query.mjs [--iterations 500]');
  iterations = Number(args[++i]);
}
if (!Number.isInteger(iterations) || iterations < 10 || iterations > 100000) throw new Error('--iterations must be an integer from 10 to 100000');

const scenarios = [
  { name: 'table-scale-ipv4-pair', pageCount: 1270, pathLength: 8, manifestBytes: 2048, a: '1.1.1.1', b: '8.8.8.8' },
  { name: 'table-scale-mixed-ip-pair', pageCount: 1270, pathLength: 8, manifestBytes: 2048, a: '1.1.1.1', b: '2001:4860:4860::8888' },
  { name: 'format-caps-mixed-ip-pair', pageCount: Math.floor(262144 / RECORD_BYTES), pathLength: 256, manifestBytes: 65536, a: '1.1.1.1', b: '2001:4860:4860::8888' },
];
const results = [];
for (const scenario of scenarios) {
  const data = fixture(scenario);
  const request = new Request(`https://benchmark.invalid/api/bgp/compare?a=${encodeURIComponent(scenario.a)}&b=${encodeURIComponent(scenario.b)}&peer=p0`);
  let maxResponseBytes = 0;
  async function query() {
    const response = await handleRequest(request, data.env);
    const text = await response.text();
    if (response.status !== 200) throw new Error(`Benchmark query returned ${response.status}: ${text}`);
    maxResponseBytes = Math.max(maxResponseBytes, encoder.encode(text).length);
    return text;
  }
  const firstStart = performance.now();
  const firstBody = JSON.parse(await query());
  const firstCallWallMs = performance.now() - firstStart;
  if (!Array.isArray(firstBody.results) || firstBody.results.length !== 2 || firstBody.results.some((result) => result.status !== 'ok')) throw new Error('Fixture must exercise two successful route lookups');
  for (let i = 0; i < 25; i += 1) await query();
  data.reset();
  const measurements = [];
  const initialCpu = process.cpuUsage();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const start = performance.now();
    await query();
    measurements.push(performance.now() - start);
  }
  const cpu = process.cpuUsage(initialCpu);
  const stats = data.stats();
  measurements.sort((a, b) => a - b);
  results.push({
    scenario: scenario.name,
    ...data.details,
    iterations,
    firstCallWallMs,
    p50LocalWallMs: percentile(measurements, 0.5),
    p95LocalWallMs: percentile(measurements, 0.95),
    p99LocalWallMs: percentile(measurements, 0.99),
    maxLocalWallMs: measurements.at(-1),
    meanNodeProcessCpuMs: (cpu.user + cpu.system) / 1000 / iterations,
    meanR2Reads: stats.reads / iterations,
    meanFetchedBytes: stats.fetchedBytes / iterations,
    maxResponseBytes,
  });
}
console.log(JSON.stringify({
  benchmark: 'Synthetic offline Node handler benchmark',
  nodeVersion: process.version,
  measuredAt: new Date().toISOString(),
  runtime: 'Node; in-memory R2 mock; not Cloudflare/workerd',
  cache: 'All requests read manifest and indices; no cross-request object cache',
  scope: 'Actual API handler, mock body copies, validation, lookup, response body consumption; fixture generation excluded',
  limitations: 'Node CPU includes mock overhead/GC/runtime threads; local wall percentiles are not provider CPU percentiles. No network latency, edge measurements, real MRT data, or deployment.',
  cloudflare10msVerified: false,
  results,
}, null, 2));
