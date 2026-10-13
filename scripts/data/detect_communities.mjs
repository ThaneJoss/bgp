import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { UndirectedGraph } from 'graphology';
import louvain from 'graphology-communities-louvain';
import { dataDirectory, readJson, readLines, relationshipRow, seededRandom, writeJson } from './data-utils.mjs';

const require = createRequire(import.meta.url);
const implementationVersion = require('graphology-communities-louvain/package.json').version;
// Graphology's exports intentionally hide package.json from subpath imports.
const graphologyVersion = JSON.parse(readFileSync(join(dirname(require.resolve('graphology')), '..', 'package.json'), 'utf8')).version;
const minimum = community => {
  let result = Infinity;
  for (const node of community) if (node < result) result = node;
  return result;
};
const bySize = (a, b) => b.size - a.size || minimum(a) - minimum(b);

export function connectedParts(graph, members) {
  const remaining = new Set(members), parts = [];
  for (const seed of [...members].sort((a, b) => a - b)) {
    if (!remaining.delete(seed)) continue;
    const part = new Set([seed]), queue = [seed];
    for (let i = 0; i < queue.length; i++) {
      for (const key of graph.neighbors(String(queue[i]))) {
        const neighbor = Number(key);
        if (remaining.delete(neighbor)) { part.add(neighbor); queue.push(neighbor); }
      }
    }
    parts.push(part);
  }
  return parts;
}

/** Newman undirected modularity; self loops contribute two to degree. */
export function modularity(graph, communities) {
  if (!graph.size) return 0;
  const owner = new Map(), degree = communities.map(() => 0), internal = communities.map(() => 0);
  communities.forEach((members, index) => {
    for (const node of members) { owner.set(String(node), index); degree[index] += graph.degree(String(node)); }
  });
  graph.forEachEdge((edge, attributes, a, b) => {
    if (owner.get(a) === owner.get(b)) internal[owner.get(a)]++;
  });
  return communities.reduce((sum, _, i) => sum + internal[i] / graph.size - (degree[i] / (2 * graph.size)) ** 2, 0);
}

export function mergeCommunities(graph, input, limit = 20) {
  const communities = input.map(members => new Set(members));
  let merged = 0;
  while (communities.length > limit) {
    const owner = new Map();
    communities.forEach((members, i) => { for (const a of members) owner.set(a, i); });
    let smallest = 0;
    for (let i = 1; i < communities.length; i++) {
      if (communities[i].size < communities[smallest].size ||
        (communities[i].size === communities[smallest].size && minimum(communities[i]) < minimum(communities[smallest]))) smallest = i;
    }
    const weights = new Map();
    for (const a of communities[smallest]) {
      for (const key of graph.neighbors(String(a))) {
        const target = owner.get(Number(key));
        if (target !== smallest) weights.set(target, (weights.get(target) ?? 0) + 1);
      }
    }
    if (!weights.size) throw new Error('Disconnected community has no adjacent target; retain explicit Other instead of artificial assignment');
    const targets = [...weights.keys()].sort((a, b) => weights.get(b) - weights.get(a) || bySize(communities[a], communities[b]));
    for (const node of communities[smallest]) communities[targets[0]].add(node);
    communities.splice(smallest, 1);
    merged++;
  }
  return { communities: communities.sort(bySize), merged };
}

export async function detectCommunities({ dataDir }) {
  const sources = await readJson(join(dataDir, 'sources.json'));
  const pairs = new Map(), nodes = new Set();
  for await (const line of readLines(join(dataDir, sources.relationships.filename))) {
    if (line.startsWith('#') || !line.trim()) continue;
    const [a, b] = relationshipRow(line), low = Math.min(a, b), high = Math.max(a, b);
    pairs.set(`${low}|${high}`, [low, high]);
    nodes.add(a); nodes.add(b);
  }
  if (!nodes.size) throw new Error('Relationship graph is empty');
  // Canonical insertion makes results independent of input row order/direction.
  const graph = new UndirectedGraph();
  for (const node of [...nodes].sort((a, b) => a - b)) graph.addNode(String(node));
  for (const [a, b] of [...pairs.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])) graph.addEdge(String(a), String(b));
  const partition = louvain(graph, { resolution: 1, getEdgeWeight: null, fastLocalMoves: false, randomWalk: true, rng: seededRandom(42) });
  const buckets = new Map();
  for (const [node, id] of Object.entries(partition)) {
    if (!buckets.has(id)) buckets.set(id, new Set());
    buckets.get(id).add(Number(node));
  }
  const raw = [...buckets.values()].sort(bySize);
  const connected = raw.flatMap(members => connectedParts(graph, members));
  const { communities, merged } = mergeCommunities(graph, connected);
  const result = {
    method: 'Louvain', implementation: 'graphology-communities-louvain', implementationVersion, graphologyVersion,
    resolution: 1, randomSeed: 42, randomGenerator: 'mulberry32', fastLocalMoves: false,
    inputOrdering: 'Ascending ASN nodes and canonical undirected edge pairs',
    rawCommunityCount: raw.length, rawCommunitySizes: raw.map(members => members.size),
    connectedCommunityCount: connected.length, rawModularity: modularity(graph, raw),
    mergedCommunityCount: merged, finalCommunityCount: communities.length, finalModularity: modularity(graph, communities),
    mergeMethod: 'Split raw communities into connected components; until at most 20 communities remain, merge the smallest community into its adjacent community with the greatest number of observed links; ties favor larger destination, then lowest ASN.',
    communities: communities.map(members => [...members].sort((a, b) => a - b)),
  };
  await writeJson(join(dataDir, 'communities.json'), result);
  console.log('FINAL', result.finalCommunityCount, 'modularity', result.finalModularity, 'sizes', communities.map(members => members.size));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await detectCommunities({ dataDir: dataDirectory() });
}
