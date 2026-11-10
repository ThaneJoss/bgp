import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { detectCommunities } from '../../scripts/data/detect_communities.mjs';
import { buildSnapshot } from '../../scripts/data/build_snapshot.mjs';
import { buildExplorer } from '../../scripts/data/build_explorer.mjs';
import {
  jsonFiles, readJson, relationshipRows, relationshipsFilename,
  sourceFixture, uniqueRelationships, writeRelationships,
} from './fixtures.mjs';

const asns = [1, 2, 3, 4, 5, 6, 7];
const degrees = { 1: 2, 2: 2, 3: 3, 4: 3, 5: 2, 6: 3, 7: 1 };
const names = { 1: 'Transit α', 2: 'Alpha Edge', 3: 'Alpha Access', 4: 'MissingOrgAS', 5: 'Beta Transit', 6: 'Beta Edge', 7: 'AS7' };
const numeric = (a, b) => a - b;
const pair = (a, b) => [a, b].sort(numeric).join(':');
const edgeType = relationship => relationship === 0 ? 'peer' : 'provider-customer';

test('fixed CAIDA input preserves the static snapshot and explorer contracts', async t => {
  const dataDir = await sourceFixture(t);
  const communities = await detectCommunities({ dataDir });
  assert.equal(communities.implementation, 'graphology-communities-louvain');
  assert.equal(communities.randomSeed, 42);
  assert.equal(communities.randomGenerator, 'mulberry32');
  assert.deepEqual(communities.communities.flat().sort(numeric), asns);
  assert.equal(communities.finalCommunityCount, communities.communities.length);
  assert(Number.isFinite(communities.finalModularity));
  assert.deepEqual(await detectCommunities({ dataDir }), communities);
  // Only the undirected projection is order/direction invariant. Snapshot
  // first-row-wins semantics deliberately remain sensitive to conflicting rows.
  await writeRelationships(dataDir, [...relationshipRows].reverse().map(([a, b, r]) => [b, a, r]));
  assert.deepEqual(await detectCommunities({ dataDir }), communities);
  await writeRelationships(dataDir);

  const topology = await buildSnapshot({ dataDir });
  assert.deepEqual(Object.keys(topology).sort(), ['groups', 'links', 'meta']);
  const { meta, groups } = topology;
  assert.equal(meta.totalAS, 7);
  assert.equal(meta.totalLinks, 9);
  assert.equal(meta.rawRelationshipRows, 12);
  assert.equal(meta.totalOrganizations, 4);
  assert.equal(meta.assignedAS, 7);
  assert.equal(meta.unassignedAS, 0);
  assert.deepEqual(meta.unassignedAsns, []);
  assert.equal(meta.peerLinks, 5);
  assert.equal(meta.providerCustomerLinks, 4);
  assert.equal(meta.withinGroupLinks + meta.betweenGroupLinks, 9);
  assert.equal(meta.fetchedDate, '2026-10-02');
  assert.equal(meta.date, '2026-09-01');
  assert.equal(meta.organizationDate, '2026-10-01');
  assert.deepEqual(meta.inputClique, [1, 2, 3]);
  assert.deepEqual(meta.bgpObservationDates, ['20260831', '20260901']);
  assert.equal(meta.communityDetection.implementation, communities.implementation);
  assert(!('communities' in meta.communityDetection));
  for (const source of Object.values(meta.sources)) {
    const bytes = await readFile(join(dataDir, source.filename));
    assert.equal(source.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  assert.deepEqual(await readJson(join(dataDir, 'metadata.json')), meta);
  const index = await readJson(join(dataDir, 'asn-index.json'));
  const assigned = await readJson(join(dataDir, 'asn-groups.json'));
  assert.deepEqual(Object.keys(index).map(Number), asns);
  const observed = new Map(uniqueRelationships.map(([a, b, r]) => [pair(a, b), [a, b, edgeType(r)]]));
  const members = [];
  const groupOf = new Map();
  for (const group of groups) {
    assert.match(group.id, /^g\d{2}$/);
    const detail = await readJson(join(dataDir, 'groups', `${group.id}.json`));
    assert.equal(detail.groupId, group.id);
    assert.equal(detail.members.length, group.asnCount);
    assert.equal(group.visibleMemberCount, group.asnCount);
    const ordered = [...detail.members].sort((a, b) => b.degree - a.degree || a.asn - b.asn);
    assert.equal(group.seedAsn, ordered[0].asn);
    const distances = new Map([[group.seedAsn, 0]]);
    const memberAsns = new Set(detail.members.map(member => member.asn));
    const queue = [group.seedAsn];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const [a, b] of uniqueRelationships) {
        const neighbor = a === queue[cursor] ? b : b === queue[cursor] ? a : undefined;
        if (memberAsns.has(neighbor) && !distances.has(neighbor)) {
          distances.set(neighbor, distances.get(queue[cursor]) + 1);
          queue.push(neighbor);
        }
      }
    }
    for (const member of detail.members) {
      assert.deepEqual(Object.keys(member).sort(), ['asn', 'country', 'degree', 'distance', 'name', 'organization']);
      assert.equal(member.name, names[member.asn]);
      assert.equal(member.degree, degrees[member.asn]);
      assert.equal(member.distance, distances.get(member.asn));
      assert.deepEqual(index[member.asn], [group.id, names[member.asn], degrees[member.asn]]);
      assert.equal(assigned[member.asn], group.id);
      groupOf.set(member.asn, group.id);
      members.push(member);
    }
    for (const edge of group.internalLinks) {
      assert.deepEqual([edge.source, edge.target, edge.relationship], observed.get(pair(edge.source, edge.target)));
    }
  }
  assert.deepEqual(members.map(member => member.asn).sort(numeric), asns);
  for (const asn of [4, 7]) {
    const member = members.find(member => member.asn === asn);
    assert.equal(member.organization, 'Unknown organization');
    assert.equal(member.country, '');
  }
  assert.equal(members.find(member => member.asn === 1).organization, 'Alpha Réseau');
  const expectedBetween = new Map();
  for (const [a, b, relationship] of uniqueRelationships) {
    const ids = [groupOf.get(a), groupOf.get(b)].sort();
    if (ids[0] === ids[1]) continue;
    const key = ids.join(':');
    if (!expectedBetween.has(key)) expectedBetween.set(key, { source: ids[0], target: ids[1], count: 0, peerCount: 0, providerCustomerCount: 0 });
    const counts = expectedBetween.get(key);
    counts.count++;
    counts[relationship === 0 ? 'peerCount' : 'providerCustomerCount']++;
  }
  assert.deepEqual(topology.links, [...expectedBetween.values()].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)));

  const output = join(dataDir, 'explorer');
  const manifest = await buildExplorer({ source: dataDir, output, targetSize: 2 });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.asnCount, 7);
  assert.equal(manifest.relationshipCount, 9);
  assert.equal(manifest.directedAdjacencyEntries, 16); // Two self-loops contribute one entry each.
  assert.equal(manifest.targetLeafSize, 2);
  assert(manifest.maxLeafSize <= 2);
  assert.equal(manifest.adjacencyBucketCount, 256);
  assert.equal(manifest.withinLeafRelationships + manifest.betweenLeavesWithinGroupRelationships + manifest.betweenRootGroupRelationships, 9);
  assert.equal(manifest.betweenRootGroupRelationships, meta.betweenGroupLinks);
  const files = await jsonFiles(output);
  assert.equal(Object.keys(files).filter(name => name.startsWith('adj/')).length, 256);
  assert.equal(Object.keys(files).filter(name => name.startsWith('names/')).length, 256);
  const leaves = Object.values(files).filter(value => value.parent && Array.isArray(value.nodes));
  assert.equal(leaves.length, manifest.leafCount);
  assert.deepEqual(leaves.flatMap(leaf => leaf.nodes.map(node => node.asn)).sort(numeric), asns);
  for (const leaf of leaves) {
    assert.equal(leaf.count, leaf.nodes.length);
    assert.equal(leaf.partition, 'bfs-tile');
    for (const node of leaf.nodes) {
      assert.equal(node.group, leaf.parent);
      assert.equal(node.name, names[node.asn]);
      assert.equal(node.degree, degrees[node.asn]);
      assert(Number.isFinite(node.x) && Number.isFinite(node.y));
      assert(Math.abs(node.x) <= 1 && Math.abs(node.y) <= 1);
      assert.deepEqual(files['index.json'][node.asn], [leaf.parent, leaf.id, names[node.asn], degrees[node.asn]]);
    }
    for (const edge of leaf.links) {
      assert.deepEqual([edge.source, edge.target, edge.relationship], observed.get(pair(edge.source, edge.target)));
    }
  }
  const expectedLeafLinks = new Map(leaves.map(leaf => [leaf.id, []]));
  const expectedTileLinks = new Map(groups.map(group => [group.id, new Map()]));
  for (const [a, b, relationship] of uniqueRelationships) {
    const [ga, la] = files['index.json'][a], [gb, lb] = files['index.json'][b];
    if (la === lb) expectedLeafLinks.get(la).push({ source: a, target: b, relationship: edgeType(relationship) });
    else if (ga === gb) {
      const key = [la, lb].sort().join(':');
      const counts = expectedTileLinks.get(ga);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  for (const leaf of leaves) assert.deepEqual(leaf.links, expectedLeafLinks.get(leaf.id));
  let observedTileRelationships = 0;
  for (const group of groups) {
    const tile = files[`${group.id}.json`];
    const expected = [...expectedTileLinks.get(group.id)].sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => { const [source, target] = key.split(':'); return { source, target, count }; });
    assert.deepEqual(tile.links, expected);
    assert.deepEqual(tile.children.map(child => child.id).sort(), leaves.filter(leaf => leaf.parent === group.id).map(leaf => leaf.id).sort());
    observedTileRelationships += tile.links.reduce((sum, link) => sum + link.count, 0);
  }
  assert.equal(manifest.withinLeafRelationships, leaves.reduce((sum, leaf) => sum + leaf.links.length, 0));
  assert.equal(manifest.betweenLeavesWithinGroupRelationships, observedTileRelationships);
  const expectedAdjacency = Object.fromEntries(asns.map(asn => [asn, []]));
  for (const [a, b, relationship] of uniqueRelationships) {
    expectedAdjacency[a].push([b, relationship === 0 ? 'peer' : 'customer']);
    if (a !== b) expectedAdjacency[b].push([a, relationship === 0 ? 'peer' : 'provider']);
  }
  for (const asn of asns) {
    const expected = expectedAdjacency[asn].sort((a, b) => degrees[b[0]] - degrees[a[0]] || a[0] - b[0]);
    assert.deepEqual(files[`adj/${asn % 256}.json`][asn].neighbors, expected);
    assert.equal(files[`names/${asn % 256}.json`][asn].name, names[asn]);
  }
  assert.deepEqual(files['adj/7.json']['7'].neighbors, [[7, 'customer']]);
  assert.equal(files['names/4.json']['4'].organization, 'Unknown organization');
  assert.deepEqual(files['root.json'].links, topology.links.map(({ source, target, count }) => ({ source, target, count })));
  assert.deepEqual(files['overview.json'].meta, meta);

  const before = await jsonFiles(dataDir);
  await detectCommunities({ dataDir });
  await buildSnapshot({ dataDir });
  await buildExplorer({ source: dataDir, output, targetSize: 2 });
  const after = await jsonFiles(dataDir);
  delete before['explorer/manifest.json'].elapsedSeconds;
  delete after['explorer/manifest.json'].elapsedSeconds;
  assert.deepEqual(after, before);
  // The compressed relationship input remains the user's source, unchanged.
  assert((await readFile(join(dataDir, relationshipsFilename))).length > 0);
});

test('snapshot accepts existing NetworkX provenance and rejects invalid community coverage', async t => {
  const dataDir = await sourceFixture(t);
  const legacy = { method: 'Louvain', networkxVersion: '3.6.1', resolution: 1, randomSeed: 42, communities: [[1, 2, 3], [4, 5, 6], [7]] };
  const writeCommunity = async communities => writeFile(join(dataDir, 'communities.json'), JSON.stringify({ ...legacy, communities }));
  await writeCommunity(legacy.communities);
  const topology = await buildSnapshot({ dataDir });
  assert.match(topology.meta.grouping, /NetworkX 3\.6\.1/);
  assert.equal(topology.meta.communityDetection.networkxVersion, legacy.networkxVersion);
  for (const [communities, message] of [
    [[[1, 2, 3], [4, 5, 6]], /cover every observed ASN/],
    [[[1, 2, 3], [3, 4, 5, 6], [7]], /multiple communities/],
    [[[1, 2, 3], [4, 5, 6], [7, 8]], /unobserved ASN/],
    [[[1, 7], [2, 3, 4, 5, 6]], /not connected/],
  ]) {
    await writeCommunity(communities);
    await assert.rejects(buildSnapshot({ dataDir }), message);
  }
  await assert.rejects(buildExplorer({ source: dataDir, output: join(dataDir, 'invalid'), targetSize: 0 }), /positive integer/);
});
