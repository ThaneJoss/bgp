import assert from 'node:assert/strict';
import test from 'node:test';
import { UndirectedGraph } from 'graphology';
import { connectedParts, mergeCommunities, modularity } from '../../scripts/data/detect_communities.mjs';
import { springLayout } from '../../scripts/data/build_explorer.mjs';

function graphOf(nodes, edges) {
  const graph = new UndirectedGraph();
  for (const node of nodes) graph.addNode(String(node));
  for (const [a, b] of edges) graph.addEdge(String(a), String(b));
  return graph;
}
const sortedMembers = communities => communities.map(members => [...members].sort((a, b) => a - b));

test('modularity agrees with independent hand-calculated unweighted graphs', () => {
  const graph = graphOf([1, 2, 3, 4, 5, 6], [[1, 2], [1, 3], [2, 3], [4, 5], [4, 6], [5, 6]]);
  // Two isolated triangles: 2 * (3/6 - (6/12)^2) = 1/2.
  assert.equal(modularity(graph, [[1, 2, 3], [4, 5, 6]]), 0.5);
  assert.equal(modularity(graph, [[1, 2, 3, 4, 5, 6]]), 0);
  assert(Math.abs(modularity(graph, [[1], [2], [3], [4], [5], [6]]) + 1 / 6) < 1e-12);
  const loop = graphOf([1, 2], [[1, 1], [1, 2]]);
  // A self-loop contributes twice to graph degree: 1/2 - (3/4)^2 - (1/4)^2.
  assert.equal(modularity(loop, [[1], [2]]), -0.125);
  assert.equal(modularity(graphOf([1], []), [[1]]), 0);
});

test('community postprocessing follows observed connectivity and stable tie rules', () => {
  const split = graphOf([1, 2, 3], [[1, 2], [3, 3]]);
  assert.deepEqual(sortedMembers(connectedParts(split, new Set([3, 2, 1]))), [[1, 2], [3]]);
  const cases = [
    { nodes: [1, 2, 3, 4, 5], sets: [[1], [4, 5], [2, 3]], edges: [[1, 2], [1, 4]], expected: [[1, 2, 3], [4, 5]] },
    { nodes: [1, 2, 3, 4, 5, 6], sets: [[1], [2, 3], [4, 5, 6]], edges: [[1, 2], [1, 4]], expected: [[1, 4, 5, 6], [2, 3]] },
    { nodes: [1, 2, 3, 4, 5, 6], sets: [[1], [2, 3], [4, 5, 6]], edges: [[1, 2], [1, 3], [1, 4]], expected: [[1, 2, 3], [4, 5, 6]] },
  ];
  for (const { nodes, sets, edges, expected } of cases) {
    const input = sets.map(members => new Set(members));
    const result = mergeCommunities(graphOf(nodes, edges), input, 2);
    assert.equal(result.merged, 1);
    assert.deepEqual(sortedMembers(result.communities), expected);
    assert.deepEqual(sortedMembers(input), sets); // The caller's partition is not mutated.
  }
  assert.throws(() => mergeCommunities(split, [[1, 2], [3]], 1), /no adjacent target/);
});

test('spring layout is repeatable, bounded, and reports real connected components', () => {
  assert.deepEqual(springLayout([], [], 42), { positions: new Map(), connectedComponents: 0 });
  assert.deepEqual(springLayout([1], [], 42), { positions: new Map([[1, [0, 0]]]), connectedComponents: 1 });
  const links = [{ source: 1, target: 2 }, { source: 2, target: 2 }];
  const result = springLayout([1, 2, 3], links, 42);
  assert.equal(result.connectedComponents, 2);
  assert.deepEqual(springLayout([1, 2, 3], links, 42), result);
  // Aggregated edge counts are display metadata rather than attraction weights.
  assert.deepEqual(springLayout([1, 2, 3], links.map(link => ({ ...link, count: 100 })), 42), result);
  assert.notDeepEqual(springLayout([1, 2, 3], [], 42).positions, result.positions);
  for (const coordinates of result.positions.values()) {
    assert(coordinates.every(value => Number.isFinite(value) && Math.abs(value) <= 1));
  }
  assert.throws(() => springLayout([1, 1], [], 42), /unique/);
  assert.throws(() => springLayout([1, 2], [{ source: 1, target: 3 }], 42), /endpoint/);
});
