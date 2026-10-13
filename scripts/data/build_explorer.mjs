#!/usr/bin/env node
/**
 * Build bounded graph drilldown assets from an existing CAIDA snapshot.
 *
 * node scripts/data/build_explorer.mjs --source ./topology-data --output ./explorer
 * Root communities are retained. Leaf tiles follow descending-degree BFS;
 * they are traversal partitions, not inferred communities or geography.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { readLines, relationshipRow } from './data-utils.mjs';

const compareIds = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const increment = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);
const pairKey = (a, b) => JSON.stringify([a, b].sort(compareIds));
const round = (value, digits) => Number(value.toFixed(digits));

function seededRandom(seed) {
  // xorshift32 has a fixed sequence independent of Math.random and NumPy.
  let state = (seed >>> 0) || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

/**
 * Deterministic, unweighted Fruchterman-Reingold layout on a simple graph.
 * All nodes repel; only observed edges attract. Aggregated link counts do not
 * become attraction weights, matching the old Graph.add_edges_from behavior.
 *
 * The force equation, cooling and distance floor follow the documented force
 * model: https://networkx.org/documentation/stable/reference/generated/networkx.drawing.layout.spring_layout.html
 * This is an independent JS implementation: xorshift32 replaces NumPy's RNG,
 * scalar JS arithmetic replaces array arithmetic, and all 28 iterations run.
 * It intentionally does not reproduce NetworkX coordinates or early stopping.
 */
export function springLayout(nodes, links, seed) {
  assert.equal(new Set(nodes).size, nodes.length, 'Layout nodes must be unique');
  if (!nodes.length) return { positions: new Map(), connectedComponents: 0 };
  if (nodes.length === 1) return { positions: new Map([[nodes[0], [0, 0]]]), connectedComponents: 1 };

  const index = new Map(nodes.map((node, i) => [node, i]));
  const neighbors = nodes.map(() => new Set());
  for (const { source, target } of links) {
    assert(index.has(source) && index.has(target), 'Layout edge endpoint is missing');
    const a = index.get(source), b = index.get(target);
    neighbors[a].add(b);
    neighbors[b].add(a);
  }
  let connectedComponents = 0;
  const visited = new Set();
  for (let seedIndex = 0; seedIndex < nodes.length; seedIndex++) {
    if (visited.has(seedIndex)) continue;
    connectedComponents++;
    visited.add(seedIndex);
    const queue = [seedIndex];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const neighbor of neighbors[queue[cursor]]) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }

  const random = seededRandom(seed);
  const positions = nodes.map(() => [random(), random()]);
  const xs = positions.map(p => p[0]), ys = positions.map(p => p[1]);
  let temperature = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.1;
  const cooling = temperature / 29;
  const k = 1.65 / Math.sqrt(nodes.length);
  for (let iteration = 0; iteration < 28; iteration++) {
    const displacement = nodes.map(() => [0, 0]);
    // O(V^2) work is bounded by the tile size; no full graph layout is done.
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const dx = positions[a][0] - positions[b][0];
        const dy = positions[a][1] - positions[b][1];
        const distance = Math.max(0.01, Math.hypot(dx, dy));
        const force = k * k / (distance * distance) - (neighbors[a].has(b) ? distance / k : 0);
        displacement[a][0] += dx * force;
        displacement[a][1] += dy * force;
        displacement[b][0] -= dx * force;
        displacement[b][1] -= dy * force;
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      const [dx, dy] = displacement[i];
      const length = Math.max(0.01, Math.hypot(dx, dy));
      positions[i][0] += dx * temperature / length;
      positions[i][1] += dy * temperature / length;
    }
    temperature -= cooling;
  }
  const center = [0, 1].map(axis => positions.reduce((sum, p) => sum + p[axis], 0) / positions.length);
  let extent = 0;
  for (const p of positions) {
    p[0] -= center[0];
    p[1] -= center[1];
    extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]));
  }
  return {
    positions: new Map(nodes.map((node, i) => [node, positions[i].map(v => round(extent ? v / extent : 0, 5))])),
    connectedComponents,
  };
}

function parseAsn(value) {
  assert(/^\d+$/.test(value), `Invalid ASN: ${value}`);
  const asn = Number(value);
  assert(Number.isSafeInteger(asn) && asn > 0 && asn <= 0xffffffff, `Invalid ASN: ${value}`);
  return asn;
}

export async function buildExplorer({ source, output, targetSize = 240 }) {
  assert(Number.isSafeInteger(targetSize) && targetSize > 0, 'target-size must be a positive integer');
  const started = performance.now();
  const oldIndex = JSON.parse(await readFile(join(source, 'asn-index.json'), 'utf8'));
  const topology = JSON.parse(await readFile(join(source, 'topology.json'), 'utf8'));
  const groupMeta = new Map(topology.groups.map(group => [group.id, group]));
  const groupNodes = new Map();
  const degree = new Map();
  for (const [asnText, [group, , nodeDegree]] of Object.entries(oldIndex)) {
    const asn = parseAsn(asnText);
    assert(groupMeta.has(group), `ASN ${asn} has no root group metadata`);
    assert(Number.isSafeInteger(nodeDegree) && nodeDegree >= 0, `Invalid degree for ASN ${asn}`);
    assert(!degree.has(asn), `Duplicate ASN ${asn}`);
    degree.set(asn, nodeDegree);
    if (!groupNodes.has(group)) groupNodes.set(group, []);
    groupNodes.get(group).push(asn);
  }
  assert(degree.size > 0, 'Snapshot must contain at least one ASN');
  const degreeOrder = (a, b) => degree.get(b) - degree.get(a) || a - b;
  const adjacency = new Map([...degree.keys()].map(asn => [asn, []]));
  const edges = [];
  const seenEdges = new Set();
  const inputFile = join(source, `${topology.meta.date.replaceAll('-', '')}.as-rel.txt.bz2`);
  for await (const line of readLines(inputFile)) {
    if (line.startsWith('#') || !line.trim()) continue;
    const [a, b, relationship] = relationshipRow(line);
    assert(adjacency.has(a) && adjacency.has(b), `Relationship ASN absent from index: ${a}, ${b}`);
    const key = `${Math.min(a, b)}|${Math.max(a, b)}`;
    // Match snapshot processing: one undirected ASN pair, first row wins. The
    // original provider/customer orientation is retained in the stored edge.
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push([a, b, relationship]);
    adjacency.get(a).push([b, relationship === 0 ? 'peer' : 'customer']);
    // A self-loop is a single neighbor in the snapshot's Set adjacency.
    if (a !== b) adjacency.get(b).push([a, relationship === 0 ? 'peer' : 'provider']);
  }
  for (const [asn, neighbors] of adjacency) {
    neighbors.sort((a, b) => degreeOrder(a[0], b[0]));
    assert.equal(neighbors.length, degree.get(asn), `Adjacency degree mismatch for ASN ${asn}`);
  }
  console.log(`Loaded ${degree.size.toLocaleString('en-US')} AS and ${edges.length.toLocaleString('en-US')} relationships`);

  const leafMembers = new Map(), leafParent = new Map(), membership = new Map(), groupChildren = new Map();
  for (const [group, members] of [...groupNodes].sort(([a], [b]) => compareIds(a, b))) {
    const memberSet = new Set(members), visited = new Set(), order = [];
    for (const seed of [...members].sort(degreeOrder)) {
      if (visited.has(seed)) continue;
      visited.add(seed);
      const queue = [seed];
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const node = queue[cursor];
        order.push(node);
        for (const [neighbor] of adjacency.get(node)) {
          if (memberSet.has(neighbor) && !visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }
    const tileCount = Math.ceil(order.length / targetSize);
    const base = Math.floor(order.length / tileCount), remainder = order.length % tileCount;
    const children = [];
    groupChildren.set(group, children);
    let cursor = 0;
    for (let i = 0; i < tileCount; i++) {
      const size = base + Number(i < remainder);
      const leaf = `${group}-c${String(i + 1).padStart(3, '0')}`;
      const nodes = order.slice(cursor, cursor + size);
      cursor += size;
      leafMembers.set(leaf, nodes);
      leafParent.set(leaf, group);
      children.push(leaf);
      for (const asn of nodes) {
        assert(!membership.has(asn), `ASN ${asn} was assigned twice`);
        membership.set(asn, leaf);
      }
    }
    assert.equal(cursor, members.length, `Incomplete root group ${group}`);
  }
  assert.equal(membership.size, degree.size, 'Incomplete ASN membership');

  const leafEdges = new Map([...leafMembers.keys()].map(leaf => [leaf, []]));
  const groupTileEdges = new Map([...groupNodes.keys()].map(group => [group, new Map()]));
  const rootEdges = new Map(), leafExternal = new Map();
  for (const [a, b, relationship] of edges) {
    const la = membership.get(a), lb = membership.get(b);
    const ga = leafParent.get(la), gb = leafParent.get(lb);
    if (la === lb) {
      leafEdges.get(la).push({ source: a, target: b, relationship: relationship === 0 ? 'peer' : 'provider-customer' });
    } else {
      increment(leafExternal, la);
      increment(leafExternal, lb);
      if (ga === gb) increment(groupTileEdges.get(ga), pairKey(la, lb));
      else increment(rootEdges, pairKey(ga, gb));
    }
  }

  // Measure only files written by this run. An existing manifest or unrelated
  // stale JSON file must not inflate the "ExcludingManifest" counters.
  const sizes = new Map();
  let compressed = 0;
  const writeJson = async (relativePath, value) => {
    const path = join(output, relativePath);
    const bytes = Buffer.from(JSON.stringify(value));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    sizes.set(relativePath, bytes.length);
    compressed += gzipSync(bytes, { level: 6 }).length;
  };
  const representative = members => [...members].sort(degreeOrder)[0];
  let leafNumber = 0;
  for (const [leaf, members] of leafMembers) {
    const { positions, connectedComponents } = springLayout(members, leafEdges.get(leaf), 42 + leafNumber);
    const seed = representative(members);
    await writeJson(`${leaf}.json`, {
      id: leaf, parent: leafParent.get(leaf), label: oldIndex[seed][1],
      count: members.length, seedAsn: seed, partition: 'bfs-tile',
      connectedComponents, externalLinkCount: leafExternal.get(leaf) ?? 0,
      nodes: [...members].sort(degreeOrder).map(asn => ({
        asn, name: oldIndex[asn][1], degree: degree.get(asn), group: leafParent.get(leaf),
        x: positions.get(asn)[0], y: positions.get(asn)[1],
      })),
      links: leafEdges.get(leaf),
    });
    leafNumber++;
    if (leafNumber % 50 === 0) console.log(`Wrote ${leafNumber}/${leafMembers.size} leaf tiles`);
  }

  const countedLinks = counts => [...counts].sort(([a], [b]) => compareIds(a, b)).map(([key, count]) => {
    const [source, target] = JSON.parse(key);
    return { source, target, count };
  });
  let groupNumber = 0;
  for (const [group, children] of groupChildren) {
    const links = countedLinks(groupTileEdges.get(group));
    const { positions } = springLayout(children, links, 9000 + groupNumber++);
    await writeJson(`${group}.json`, {
      id: group, label: groupMeta.get(group).label, count: groupNodes.get(group).length, partition: 'bfs-tile',
      children: children.map(child => {
        const members = leafMembers.get(child), seed = representative(members);
        return { id: child, label: oldIndex[seed][1], count: members.length, seedAsn: seed,
          x: positions.get(child)[0], y: positions.get(child)[1] };
      }),
      links,
    });
  }

  const nameInfo = new Map();
  for (const group of groupNodes.keys()) {
    let detail;
    try {
      detail = JSON.parse(await readFile(join(source, 'groups', `${group}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const member of detail.members) {
      nameInfo.set(member.asn, Object.fromEntries(['name', 'organization', 'country'].map(key => [key, member[key] === undefined ? '' : member[key]])));
    }
  }
  const asns = [...degree.keys()].sort((a, b) => a - b);
  const nameShards = Array.from({ length: 256 }, () => ({}));
  const adjacencyShards = Array.from({ length: 256 }, () => ({}));
  for (const asn of asns) {
    nameShards[asn % 256][asn] = nameInfo.get(asn) ?? { name: oldIndex[asn][1] };
    adjacencyShards[asn % 256][asn] = { neighbors: adjacency.get(asn) };
  }
  for (let bucket = 0; bucket < 256; bucket++) await writeJson(`names/${bucket}.json`, nameShards[bucket]);
  await writeJson('index.json', Object.fromEntries(asns.map(asn => [asn, [oldIndex[asn][0], membership.get(asn), oldIndex[asn][1], degree.get(asn)]])));
  for (let bucket = 0; bucket < 256; bucket++) await writeJson(`adj/${bucket}.json`, adjacencyShards[bucket]);
  await writeJson('overview.json', {
    meta: topology.meta,
    groups: topology.groups.map(group => Object.fromEntries(['id', 'label', 'seedAsn', 'asnCount', 'country'].map(key => [key, group[key]]))),
    links: topology.links,
  });
  await writeJson('root.json', {
    groups: topology.groups.map(group => ({ id: group.id, label: group.label, count: group.asnCount, seedAsn: group.seedAsn, color: group.color })),
    links: countedLinks(rootEdges),
  });

  const sum = values => [...values].reduce((a, b) => a + b, 0);
  const withinLeaf = sum([...leafEdges.values()].map(links => links.length));
  const betweenLeaf = sum([...groupTileEdges.values()].map(counts => sum(counts.values())));
  const betweenGroup = sum(rootEdges.values());
  const directedAdjacencyEntries = sum([...adjacency.values()].map(neighbors => neighbors.length));
  const selfLoops = edges.filter(([a, b]) => a === b).length;
  assert.equal(withinLeaf + betweenLeaf + betweenGroup, edges.length, 'Relationship aggregation mismatch');
  assert.equal(directedAdjacencyEntries, 2 * edges.length - selfLoops, 'Incomplete adjacency');
  assert.equal(betweenGroup, topology.meta.betweenGroupLinks, 'Root group relationship count differs from snapshot');
  const fileEntries = [...sizes].sort(([a], [b]) => compareIds(a, b));
  const [largestFile, largestFileBytes] = fileEntries.reduce((largest, entry) => entry[1] > largest[1] ? entry : largest);
  const leafSizes = [...leafMembers.values()].map(members => members.length);
  const manifest = {
    schemaVersion: 1, snapshotDate: topology.meta.date, source: topology.meta.source,
    rootGroups: groupNodes.size, asnCount: degree.size, relationshipCount: edges.length, directedAdjacencyEntries,
    leafCount: leafMembers.size, targetLeafSize: targetSize, minLeafSize: Math.min(...leafSizes), maxLeafSize: Math.max(...leafSizes),
    withinLeafRelationships: withinLeaf, betweenLeavesWithinGroupRelationships: betweenLeaf, betweenRootGroupRelationships: betweenGroup,
    adjacencyBucketCount: 256, adjacencyBucketFormula: 'ASN % 256 (decimal filename)',
    leafPartitionMethod: 'Deterministic descending-degree breadth-first traversal within each existing root community, divided into equally sized tiles of at most targetLeafSize. Tiles need not be connected; no links are invented.',
    rootPartitionMethod: topology.meta.grouping,
    layoutMethod: 'JavaScript Fruchterman-Reingold spring layout, real unweighted edges only, 28 iterations, xorshift32 fixed seeds, k=1.65/sqrt(node count); centered coordinates normalized to [-1,1] and rounded to 5 decimals. Coordinates differ from NetworkX/NumPy.',
    nameSemantics: 'Tile label is its highest-degree ASN name; it is not ownership or geography.',
    relationshipDirection: 'In leaf links, provider-customer source is provider and target is customer. Adjacency roles describe the neighbor relative to the queried ASN.',
    allAsnsAssignedExactlyOnce: true, allRelationshipsPreserved: true,
    totalJsonBytesExcludingManifest: sum(sizes.values()), estimatedGzipBytesExcludingManifest: compressed,
    largestFile, largestFileBytes, elapsedSeconds: round((performance.now() - started) / 1000, 2), files: Object.fromEntries(fileEntries),
  };
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: 'string' }, output: { type: 'string' },
    'target-size': { type: 'string', default: '240' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/data/build_explorer.mjs --source <snapshot-directory> --output <explorer-directory> [--target-size 240]');
    return;
  }
  assert(values.source && values.output, '--source and --output are required');
  const manifest = await buildExplorer({ source: resolve(values.source), output: resolve(values.output), targetSize: Number(values['target-size']) });
  const summary = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'files'));
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
