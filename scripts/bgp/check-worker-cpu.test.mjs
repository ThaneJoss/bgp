import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateRecords, parseRecords } from './check-worker-cpu.mjs';

const samples = () => Array.from({ length: 1000 }, () => ({
  $workers: { cpuTimeMs: 1.2, wallTimeMs: 50, outcome: 'ok' },
}));

test('CPU budget uses provider CPU, not slower wall time', () => {
  const result = evaluateRecords(samples());
  assert.equal(result.passed, true);
  assert.equal(result.p99CpuMs, 1.2);
  assert.equal(result.p99WallMs, 50);
});

test('missing measurements and provider errors fail the gate', () => {
  for (const record of [
    { wallTimeMs: 0, outcome: 'ok' },
    { cpuTimeMs: 0 },
    { cpuTimeMs: 1, outcome: 'exceededCpu' },
    { cpuTimeMs: 10, outcome: 'ok' },
  ]) assert.equal(evaluateRecords([...samples(), record]).passed, false);
});

test('small samples or insufficient p99 reserve fail the gate', () => {
  assert.equal(evaluateRecords([{ cpuTimeMs: 0, outcome: 'ok' }]).passed, false);
  assert.equal(evaluateRecords(Array.from({ length: 1000 }, () => ({ cpuTimeMs: 7, outcome: 'ok' }))).passed, false);
});

test('parse JSON arrays, event containers, and NDJSON', () => {
  assert.equal(parseRecords('[{"cpuTimeMs":1}]').length, 1);
  assert.equal(parseRecords('{"events":[{"cpuTimeMs":1}]}').length, 1);
  assert.equal(parseRecords('{"cpuTimeMs":1}\n{"cpuTimeMs":2}').length, 2);
  assert.throws(() => parseRecords('{broken}'));
});

test('custom metrics field paths are supported without interpreting strings as measurements', () => {
  const options = { minimumSamples: 1, cpuField: 'timing.cpu', outcomeField: 'status' };
  assert.equal(evaluateRecords([{ timing: { cpu: 2 }, status: 'ok' }], options).passed, true);
  assert.equal(evaluateRecords([{ timing: { cpu: '2' }, status: 'ok' }], options).passed, false);
});
