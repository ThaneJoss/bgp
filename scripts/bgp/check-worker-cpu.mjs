#!/usr/bin/env node
/**
 * Audit exported Cloudflare invocation metrics; never substitute browser latency
 * or performance.now() for Cloudflare's measured CPU time.
 * This script reads local files only and makes no network requests.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CPU_FIELDS = ['$workers.cpuTimeMs', 'cpuTimeMs', 'CPUTimeMs'];
const OUTCOME_FIELDS = ['$workers.outcome', 'outcome', 'Outcome'];
const WALL_FIELDS = ['$workers.wallTimeMs', 'wallTimeMs', 'WallTimeMs'];

function field(record, path) {
  // Some export formats flatten field names; prefer the exact property.
  if (Object.hasOwn(record, path)) return record[path];
  return path.split('.').reduce((value, key) => value?.[key], record);
}

function firstField(record, paths) {
  for (const path of paths) {
    const value = field(record, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function parseRecords(text) {
  let whole;
  try { whole = JSON.parse(text); } catch { /* An NDJSON export is also valid. */ }
  if (Array.isArray(whole)) return whole;
  if (whole && typeof whole === 'object') {
    if (Array.isArray(whole.events)) return whole.events;
    if (Array.isArray(whole.result)) return whole.result;
    return [whole];
  }
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Invalid JSON on non-empty input line ${index + 1}`); }
  });
}

export function evaluateRecords(records, options = {}) {
  const minimumSamples = options.minimumSamples ?? 1000;
  const p99BudgetMs = options.p99BudgetMs ?? 5;
  const hardLimitMs = options.hardLimitMs ?? 10;
  const cpuFields = options.cpuField ? [options.cpuField] : CPU_FIELDS;
  const outcomeFields = options.outcomeField ? [options.outcomeField] : OUTCOME_FIELDS;
  const cpu = [];
  const wall = [];
  const outcomes = Object.create(null);
  let invalidCpu = 0;
  let missingOutcome = 0;
  let ignoredCustomLogs = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      invalidCpu += 1;
      missingOutcome += 1;
      continue;
    }
    const type = field(record, '$cloudflare.$metadata.type');
    if (typeof type === 'string' && type !== 'cf-worker-event') {
      ignoredCustomLogs += 1;
      continue;
    }
    const cpuMs = firstField(record, cpuFields);
    if (typeof cpuMs !== 'number' || !Number.isFinite(cpuMs) || cpuMs < 0) invalidCpu += 1;
    else cpu.push(cpuMs);
    const wallMs = firstField(record, WALL_FIELDS);
    if (typeof wallMs === 'number' && Number.isFinite(wallMs) && wallMs >= 0) wall.push(wallMs);
    const outcome = firstField(record, outcomeFields);
    if (typeof outcome !== 'string' || !outcome) missingOutcome += 1;
    else outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  cpu.sort((a, b) => a - b);
  wall.sort((a, b) => a - b);
  const maxCpuMs = cpu.at(-1) ?? null;
  const p99CpuMs = percentile(cpu, 0.99);
  const failedOutcomes = Object.entries(outcomes).filter(([outcome]) => outcome !== 'ok');
  const reasons = [];
  if (cpu.length < minimumSamples) reasons.push(`Need ${minimumSamples} CPU samples; found ${cpu.length}`);
  if (invalidCpu) reasons.push(`${invalidCpu} invocation records lack valid Cloudflare CPU measurements`);
  if (missingOutcome) reasons.push(`${missingOutcome} invocation records lack an outcome`);
  if (failedOutcomes.length) reasons.push(`Non-ok outcomes: ${failedOutcomes.map(([name, count]) => `${name}=${count}`).join(', ')}`);
  if (p99CpuMs !== null && p99CpuMs > p99BudgetMs) reasons.push(`p99 CPU ${p99CpuMs} ms exceeds reserve budget ${p99BudgetMs} ms`);
  if (maxCpuMs !== null && maxCpuMs >= hardLimitMs) reasons.push(`Maximum CPU ${maxCpuMs} ms reaches or exceeds ${hardLimitMs} ms`);
  return {
    passed: reasons.length === 0,
    evidence: 'Cloudflare invocation export supplied by caller; this tool does not authenticate its provenance',
    samples: cpu.length,
    ignoredCustomLogs,
    missingCpuSamples: invalidCpu,
    missingOutcomeSamples: missingOutcome,
    p50CpuMs: percentile(cpu, 0.5),
    p95CpuMs: percentile(cpu, 0.95),
    p99CpuMs,
    maxCpuMs,
    p99WallMs: percentile(wall, 0.99),
    outcomes,
    thresholds: { minimumSamples, p99BudgetMs, hardLimitMs },
    reasons,
    limitation: 'Passing this sample is not a guarantee for unseen traffic, data, runtimes, or future deployments.',
  };
}

function parseOptions(args) {
  const options = {};
  let input;
  const names = {
    '--min-samples': 'minimumSamples',
    '--p99-budget-ms': 'p99BudgetMs',
    '--hard-limit-ms': 'hardLimitMs',
    '--cpu-field': 'cpuField',
    '--outcome-field': 'outcomeField',
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (names[arg]) {
      const raw = args[++i];
      if (!raw) throw new Error(`Missing value for ${arg}`);
      const name = names[arg];
      options[name] = name.endsWith('Field') ? raw : Number(raw);
      if (!name.endsWith('Field') && (!Number.isFinite(options[name]) || options[name] <= 0)) throw new Error(`Invalid positive number for ${arg}`);
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (input) throw new Error('Pass only one input file');
    else input = arg;
  }
  if (!input) throw new Error('Usage: node scripts/bgp/check-worker-cpu.mjs invocation-logs.jsonl [--min-samples 1000] [--cpu-field $workers.cpuTimeMs]');
  if (options.minimumSamples && !Number.isInteger(options.minimumSamples)) throw new Error('--min-samples must be an integer');
  return { input, options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { input, options } = parseOptions(process.argv.slice(2));
    const report = evaluateRecords(parseRecords(await readFile(input, 'utf8')), options);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
