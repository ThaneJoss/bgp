#!/usr/bin/env node
/** Build the existing static topology and ASN indexes from local CAIDA inputs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDirectory, readLines, relationshipRow } from './data-utils.mjs';

const PALETTE = [
  '#56c8e8', '#9ba3f7', '#5dd6ad', '#ebba70', '#e58bc4', '#f28282',
  '#74bbf0', '#c3c971', '#7cd4c7', '#b895e2', '#ddaa86', '#97c6d8',
  '#84be94', '#e4d18a', '#c28298', '#9cbded', '#d8a96e', '#a6d2b9',
  '#c7b8eb', '#e6a8a0',
];
const groupId = rank => `g${String(rank + 1).padStart(2, '0')}`;

function integer(value, context) {
  const text = value?.trim();
  if (!text || !/^[+-]?\d+$/.test(text)) throw new Error(`Invalid integer in ${context}: ${value}`);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) throw new Error(`Integer exceeds JavaScript's exact range in ${context}: ${value}`);
  return number;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function implementationDescription(result) {
  if (result.implementation) {
    return `${result.implementation}${result.implementationVersion ? ` ${result.implementationVersion}` : ''}`;
  }
  // Existing community files remain usable and retain their actual provenance.
  if (result.networkxVersion) return `NetworkX ${result.networkxVersion}`;
  return 'implementation unspecified in communities.json';
}

/**
 * Keep the legacy ordering and counts for a fixed community partition. The
 * community detector is separate: changing its Louvain implementation can
 * change this partition, even when its resolution and seed are unchanged.
 */
export async function buildSnapshot({ dataDir = dataDirectory([]) } = {}) {
  const sources = JSON.parse(await readFile(join(dataDir, 'sources.json'), 'utf8'));
  assert(sources.organizations?.filename && sources.relationships?.filename,
    'sources.json must identify organization and relationship input files');

  const organizations = new Map();
  const asInfo = new Map();
  let mode;
  for await (const line of readLines(join(dataDir, sources.organizations.filename))) {
    if (line.startsWith('# format:org_id')) { mode = 'org'; continue; }
    if (line.startsWith('# format:aut')) { mode = 'as'; continue; }
    if (line.startsWith('#') || !line.trim()) continue;
    const fields = line.split('|');
    if (mode === 'org') {
      assert(fields.length >= 4, 'Malformed organization row');
      organizations.set(fields[0], { name: fields[2], country: fields[3] });
    } else if (mode === 'as') {
      assert(fields.length >= 4, 'Malformed ASN organization row');
      asInfo.set(integer(fields[0], 'organization row'), { name: fields[2], orgId: fields[3] });
    }
  }

  const links = [];
  const adjacency = new Map();
  const seen = new Set();
  const observationDates = new Set();
  let rawRelationshipRows = 0;
  let inputClique = [];
  const neighbors = asn => {
    if (!adjacency.has(asn)) adjacency.set(asn, new Set());
    return adjacency.get(asn);
  };
  for await (const line of readLines(join(dataDir, sources.relationships.filename))) {
    if (line.startsWith('# input clique:')) {
      const text = line.slice(line.indexOf(':') + 1).trim();
      inputClique = text ? text.split(/\s+/).map(value => integer(value, 'input clique')) : [];
    }
    if (line.startsWith('# source:topology|BGP|')) {
      observationDates.add(line.split('|')[2]);
    }
    if (line.startsWith('#') || !line.trim()) continue;
    const [a, b, relationship] = relationshipRow(line);
    rawRelationshipRows += 1;
    // A repeated or reversed pair retains the first row's direction/type.
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push([a, b, relationship]);
    neighbors(a).add(b);
    neighbors(b).add(a);
  }

  const allAsns = [...adjacency.keys()].sort((a, b) => a - b);
  const degree = asn => adjacency.get(asn).size;
  const byDegree = (a, b) => degree(b) - degree(a) || a - b;
  const organizationOf = asn => asInfo.get(asn)?.orgId ?? `unknown-AS${asn}`;
  const organizationIds = new Set(allAsns.map(organizationOf));
  const communityResult = JSON.parse(await readFile(join(dataDir, 'communities.json'), 'utf8'));
  assert(Array.isArray(communityResult.communities), 'communities.json must contain communities');
  const communitySets = communityResult.communities.map((values, rank) => {
    assert(Array.isArray(values) && values.length > 0, `Community ${rank} must have members`);
    for (const asn of values) assert(Number.isSafeInteger(asn), `Invalid ASN in community ${rank}`);
    return new Set(values);
  });
  const owner = new Map();
  for (const [rank, community] of communitySets.entries()) {
    for (const asn of community) {
      assert(adjacency.has(asn), `Community ${rank} contains an unobserved ASN ${asn}`);
      assert(!owner.has(asn), `ASN ${asn} appears in multiple communities`);
      owner.set(asn, rank);
    }
  }
  assert.equal(owner.size, allAsns.length, 'Communities must cover every observed ASN');

  const seeds = [];
  const best = new Map();
  for (const [rank, community] of communitySets.entries()) {
    const ordered = [...community].sort(byDegree);
    const primary = ordered[0];
    const organizationId = organizationOf(primary);
    const seedAsns = ordered.filter(asn => organizationOf(asn) === organizationId);
    seeds.push({ organizationId, seedAsns, ordered });

    const distances = new Map([[primary, 0]]);
    const queue = [primary];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const asn = queue[cursor];
      for (const neighbor of adjacency.get(asn)) {
        if (community.has(neighbor) && !distances.has(neighbor)) {
          distances.set(neighbor, distances.get(asn) + 1);
          queue.push(neighbor);
        }
      }
    }
    assert.equal(distances.size, community.size, `Community ${rank} is not connected`);
    for (const [asn, distance] of distances) best.set(asn, { distance, rank });
  }

  const internalByGroup = communitySets.map(() => []);
  const edgesBetweenGroups = new Map();
  let peerLinks = 0;
  let providerCustomerLinks = 0;
  for (const [a, b, relationship] of links) {
    peerLinks += Number(relationship === 0);
    providerCustomerLinks += Number(relationship === -1);
    const ga = owner.get(a);
    const gb = owner.get(b);
    if (ga === gb) {
      internalByGroup[ga].push([a, b, relationship]);
    } else {
      const source = Math.min(ga, gb);
      const target = Math.max(ga, gb);
      const key = `${source}:${target}`;
      if (!edgesBetweenGroups.has(key)) {
        edgesBetweenGroups.set(key, { source, target, count: 0, peerCount: 0, providerCustomerCount: 0 });
      }
      const edge = edgesBetweenGroups.get(key);
      edge.count += 1;
      edge.peerCount += Number(relationship === 0);
      edge.providerCustomerCount += Number(relationship === -1);
    }
  }

  const member = asn => {
    const info = asInfo.get(asn);
    const organization = organizations.get(organizationOf(asn));
    return {
      asn,
      name: info?.name ?? `AS${asn}`,
      organization: organization?.name ?? 'Unknown organization',
      country: organization?.country ?? '',
      degree: degree(asn),
      distance: best.get(asn)?.distance ?? null,
    };
  };
  const groups = seeds.map(({ organizationId, seedAsns, ordered }, rank) => {
    const visible = [...new Set([...seedAsns.slice(0, 24), ...ordered.slice(0, 96)])].slice(0, 120);
    const visibleSet = new Set(visible);
    const internal = internalByGroup[rank]
      .filter(([a, b]) => visibleSet.has(a) && visibleSet.has(b))
      .sort((a, b) => degree(b[0]) + degree(b[1]) - degree(a[0]) - degree(a[1]) || a[0] - b[0] || a[1] - b[1]);
    const externalAsns = new Set();
    const distances = new Map();
    for (const asn of ordered) {
      for (const neighbor of adjacency.get(asn)) if (owner.get(neighbor) !== rank) externalAsns.add(neighbor);
      const distance = best.get(asn).distance;
      distances.set(distance, (distances.get(distance) ?? 0) + 1);
    }
    const organization = organizations.get(organizationId);
    return {
      id: groupId(rank),
      label: organization?.name ?? organizationId,
      organizationId,
      seedAsn: seedAsns[0],
      seedAsns,
      seedOrganizationAsnCount: seedAsns.length,
      externalNeighborAsnCount: externalAsns.size,
      country: organization?.country ?? '',
      color: PALETTE[rank % PALETTE.length],
      asnCount: ordered.length,
      organizationCount: new Set(ordered.map(organizationOf)).size,
      internalLinkCount: internalByGroup[rank].length,
      members: visible.map(member),
      visibleMemberCount: visible.length,
      memberSample: 'Seed ASNs and highest-degree members, at most 120 ASNs.',
      internalLinks: internal.slice(0, 1500).map(([source, target, relationship]) => ({
        source, target, relationship: relationship === 0 ? 'peer' : 'provider-customer',
      })),
      visibleInternalLinkCount: Math.min(1500, internal.length),
      totalLinksBetweenVisibleMembers: internal.length,
      distanceDistribution: Object.fromEntries([...distances].sort((a, b) => a[0] - b[0])),
    };
  });

  const groupLinks = [...edgesBetweenGroups.values()]
    .sort((a, b) => a.source - b.source || a.target - b.target)
    .map(({ source, target, ...counts }) => ({ source: groupId(source), target: groupId(target), ...counts }));
  const communityDetection = Object.fromEntries(Object.entries(communityResult)
    .filter(([key]) => key !== 'communities'));
  const fetchedDateOf = source => source.fetchedDate ?? source.fetchedAt?.slice(0, 10);
  const meta = {
    source: 'CAIDA AS Relationships (serial-1) and AS Organizations',
    date: sources.relationships.snapshotDate,
    organizationDate: sources.organizations.snapshotDate,
    fetchedDate: fetchedDateOf(sources.relationships) ?? fetchedDateOf(sources.organizations) ?? '2026-09-22',
    totalAS: allAsns.length,
    totalLinks: links.length,
    rawRelationshipRows,
    totalOrganizations: organizationIds.size,
    groupCount: groups.length,
    assignedAS: best.size,
    unassignedAS: 0,
    unassignedAsns: [],
    peerLinks,
    providerCustomerLinks,
    betweenGroupLinks: groupLinks.reduce((sum, edge) => sum + edge.count, 0),
    withinGroupLinks: internalByGroup.reduce((sum, edges) => sum + edges.length, 0),
    grouping: `Topology communities detected with ${communityResult.method ?? 'Louvain'} modularity optimization on the complete undirected, unweighted observed AS graph (${implementationDescription(communityResult)}; resolution ${communityResult.resolution ?? 1}; random seed ${communityResult.randomSeed ?? 42}). Split communities into connected components; if more than 20 remain, repeatedly merge the smallest into its strongest adjacent community by observed edge count, breaking ties by destination size then lowest ASN. Group names identify the organization of the highest-degree member ASN; they do not imply ownership, geography, or commercial allegiance.`,
    groupingZh: '使用 Louvain 算法按实际 AS 连接结构划分拓扑社群；小社群按真实连接数并入联系最紧密的相邻社群。名称取自组内连接最多的 ASN 所属组织，仅用于识别，不表示组织所有权、地理区域或商业关系。',
    memberSampling: 'Each group detail previews up to 120 seed/highest-degree ASNs and at most 1500 observed links among preview ASNs. Full ASN-to-group mapping and complete member detail files are provided separately.',
    coverage: 'ASNs and relationships observed or inferred in this CAIDA snapshot, not a complete real-time census of the Internet. BGP-derived relationship data are not physical cables or live traffic.',
    relationshipMeaning: {
      peer: 'CAIDA relationship 0: peer-to-peer',
      'provider-customer': 'CAIDA relationship -1: source provider, target customer',
    },
    sources,
    bgpObservationDates: [...observationDates].sort(),
    inputClique,
    communityDetection,
    memberDistanceMeaning: 'Shortest undirected path inside the community from its highest-degree representative ASN.',
  };
  for (const source of Object.values(sources)) source.sha256 = await sha256(join(dataDir, source.filename));
  const result = { meta, groups, links: groupLinks };
  const asnGroups = Object.fromEntries(allAsns.map(asn => [asn, groupId(owner.get(asn))]));
  const asnIndex = Object.fromEntries(allAsns.map(asn => [asn, [
    groupId(owner.get(asn)), asInfo.get(asn)?.name ?? `AS${asn}`, degree(asn),
  ]]));

  // Check the same graph/sampling invariants before emitting any output files.
  assert.equal(groups.reduce((sum, group) => sum + group.asnCount, 0), allAsns.length);
  assert.equal(new Set(groups.map(group => group.id)).size, communitySets.length);
  assert.equal(meta.withinGroupLinks + meta.betweenGroupLinks, meta.totalLinks);
  for (const [asn, adjacent] of adjacency) {
    for (const neighbor of adjacent) assert(adjacency.get(neighbor).has(asn));
  }
  for (const group of groups) {
    const visible = new Set(group.members.map(value => value.asn));
    assert.equal(group.members.length, visible.size);
    for (const edge of group.internalLinks) {
      assert(visible.has(edge.source) && visible.has(edge.target) && adjacency.get(edge.source).has(edge.target));
    }
  }

  await mkdir(join(dataDir, 'groups'), { recursive: true });
  for (const [rank, group] of groups.entries()) {
    await writeFile(join(dataDir, 'groups', `${group.id}.json`), JSON.stringify({
      groupId: group.id, members: seeds[rank].ordered.map(member),
    }));
  }
  await writeFile(join(dataDir, 'topology.json'), JSON.stringify(result));
  await writeFile(join(dataDir, 'asn-groups.json'), JSON.stringify(asnGroups));
  await writeFile(join(dataDir, 'asn-index.json'), JSON.stringify(asnIndex));
  await writeFile(join(dataDir, 'metadata.json'), JSON.stringify(meta, null, 2));
  return result;
}

async function main() {
  const dataDir = dataDirectory();
  const { meta, groups } = await buildSnapshot({ dataDir });
  const summaryKeys = new Set([
    'date', 'totalAS', 'totalLinks', 'totalOrganizations', 'assignedAS', 'unassignedAS',
    'peerLinks', 'providerCustomerLinks', 'betweenGroupLinks', 'withinGroupLinks',
  ]);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(meta).filter(([key]) => summaryKeys.has(key))), null, 2));
  for (const group of groups) {
    console.log(group.id, group.label, 'seed', group.seedAsn, 'ASNs', group.asnCount,
      'orgSeedASNs', group.seedOrganizationAsnCount, 'externalNeighborASNs', group.externalNeighborAsnCount);
  }
  for (const name of ['topology.json', 'asn-groups.json', 'asn-index.json']) {
    console.log(name, (await stat(join(dataDir, name))).size);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
