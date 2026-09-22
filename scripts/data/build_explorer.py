#!/usr/bin/env python3
"""Build complete, bounded AS graph drilldown assets from a CAIDA snapshot.

Usage: python build_explorer.py --source ../topology-data --output ./explorer
Needs numpy and networkx (networkx may live in source/python-deps).
Existing root communities are retained; bounded leaf tiles are deterministic
degree-ordered BFS traversal partitions, not inferred communities or geography.
All adjacency is retained, including edges crossing both tile and group borders.
"""
import argparse
import bz2
from collections import Counter, defaultdict, deque
import gzip
import json
import math
from pathlib import Path
import sys
import time


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--target-size', type=int, default=240)
    args = parser.parse_args()
    started = time.monotonic()
    sys.path.insert(0, str(args.source / 'python-deps'))
    import networkx as nx

    old_index = json.loads((args.source / 'asn-index.json').read_text())
    topology = json.loads((args.source / 'topology.json').read_text())
    group_meta = {g['id']: g for g in topology['groups']}
    group_nodes = defaultdict(list)
    for asn, (group, name, degree) in old_index.items():
        group_nodes[group].append(int(asn))
    degree = {int(asn): value[2] for asn, value in old_index.items()}
    adjacency = {asn: [] for asn in degree}
    edges = []
    input_file = args.source / (topology['meta']['date'].replace('-', '') + '.as-rel.txt.bz2')
    with bz2.open(input_file, 'rt') as handle:
        for line in handle:
            if line.startswith('#') or not line.strip():
                continue
            values = line.strip().split('|')
            a, b, relationship = int(values[0]), int(values[1]), int(values[2])
            assert relationship in (0, -1), (a, b, relationship)
            assert a in adjacency and b in adjacency
            edges.append((a, b, relationship))
            adjacency[a].append((b, 'peer' if relationship == 0 else 'customer'))
            adjacency[b].append((a, 'peer' if relationship == 0 else 'provider'))
    for asn, neighbors in adjacency.items():
        neighbors.sort(key=lambda p: (-degree[p[0]], p[0]))
        assert len(neighbors) == degree[asn], (asn, len(neighbors), degree[asn])
    print(f'Loaded {len(degree):,} AS and {len(edges):,} relationships', flush=True)

    # Ordering follows only real intra-group edges. Equal-sized chunks bound
    # browser work. A chunk can contain disconnected components: no invented
    # links are added to make the visualization look connected.
    leaf_members, leaf_parent, membership, group_children = {}, {}, {}, {}
    for group, members in sorted(group_nodes.items()):
        member_set = set(members)
        visited, order = set(), []
        for seed in sorted(members, key=lambda n: (-degree[n], n)):
            if seed in visited:
                continue
            visited.add(seed)
            queue = deque([seed])
            while queue:
                node = queue.popleft()
                order.append(node)
                for neighbor, _ in adjacency[node]:
                    if neighbor in member_set and neighbor not in visited:
                        visited.add(neighbor)
                        queue.append(neighbor)
        tile_count = math.ceil(len(order) / args.target_size)
        base, remainder = divmod(len(order), tile_count)
        group_children[group] = []
        cursor = 0
        for i in range(tile_count):
            size = base + (i < remainder)
            leaf = f'{group}-c{i + 1:03d}'
            nodes = order[cursor:cursor + size]
            cursor += size
            leaf_members[leaf] = nodes
            leaf_parent[leaf] = group
            group_children[group].append(leaf)
            for asn in nodes:
                assert asn not in membership
                membership[asn] = leaf
        assert cursor == len(members)
    assert len(membership) == len(degree)

    leaf_edges = defaultdict(list)
    group_tile_edges = defaultdict(Counter)
    root_edges = Counter()
    leaf_external = Counter()
    for a, b, relationship in edges:
        la, lb = membership[a], membership[b]
        ga, gb = leaf_parent[la], leaf_parent[lb]
        if la == lb:
            leaf_edges[la].append({'source': a, 'target': b,
                'relationship': 'peer' if relationship == 0 else 'provider-customer'})
        else:
            leaf_external[la] += 1
            leaf_external[lb] += 1
            if ga == gb:
                group_tile_edges[ga][tuple(sorted((la, lb)))] += 1
            else:
                root_edges[tuple(sorted((ga, gb)))] += 1

    def layout(nodes, links, seed):
        graph = nx.Graph()
        graph.add_nodes_from(nodes)
        graph.add_edges_from((e['source'], e['target']) for e in links)
        if len(nodes) == 1:
            return {nodes[0]: (0.0, 0.0)}, 1
        # Force layout uses actual edges only. The coordinate unit is normalized
        # to [-1, 1]; clients can project it to their own viewport dimensions.
        positions = nx.spring_layout(graph, seed=seed, iterations=28, scale=1.0,
            k=1.65 / math.sqrt(len(nodes)), method='force')
        return {n: (round(float(v[0]), 5), round(float(v[1]), 5))
                for n, v in positions.items()}, nx.number_connected_components(graph)

    leaf_components = {}
    for i, (leaf, members) in enumerate(leaf_members.items()):
        positions, components = layout(members, leaf_edges[leaf], 42 + i)
        leaf_components[leaf] = components
        seed = max(members, key=lambda n: (degree[n], -n))
        label = old_index[str(seed)][1]
        write_json(args.output / f'{leaf}.json', {
            'id': leaf, 'parent': leaf_parent[leaf], 'label': label,
            'count': len(members), 'seedAsn': seed, 'partition': 'bfs-tile',
            'connectedComponents': components, 'externalLinkCount': leaf_external[leaf],
            'nodes': [{'asn': n, 'name': old_index[str(n)][1], 'degree': degree[n],
                'group': leaf_parent[leaf], 'x': positions[n][0], 'y': positions[n][1]}
                for n in sorted(members, key=lambda n: (-degree[n], n))],
            'links': leaf_edges[leaf]})
        if (i + 1) % 50 == 0:
            print(f'Wrote {i + 1}/{len(leaf_members)} leaf tiles', flush=True)

    for i, (group, children) in enumerate(group_children.items()):
        links = [{'source': a, 'target': b, 'count': count}
            for (a, b), count in sorted(group_tile_edges[group].items())]
        positions, _ = layout(children, links, 9000 + i)
        child_records = []
        for child in children:
            members = leaf_members[child]
            seed = max(members, key=lambda n: (degree[n], -n))
            child_records.append({'id': child, 'label': old_index[str(seed)][1],
                'count': len(members), 'seedAsn': seed,
                'x': positions[child][0], 'y': positions[child][1]})
        write_json(args.output / f'{group}.json', {'id': group,
            'label': group_meta[group]['label'], 'count': len(group_nodes[group]),
            'partition': 'bfs-tile', 'children': child_records, 'links': links})

    name_info = {}
    for group in group_nodes:
        detail_path = args.source / 'groups' / f'{group}.json'
        if detail_path.exists():
            detail = json.loads(detail_path.read_text())
            for member in detail['members']:
                name_info[str(member['asn'])] = {k: member.get(k, '') for k in ('name', 'organization', 'country')}
    name_shards = defaultdict(dict)
    for asn in sorted(degree):
        name_shards[asn % 256][str(asn)] = name_info.get(str(asn), {'name': old_index[str(asn)][1]})
    for bucket in range(256):
        write_json(args.output / 'names' / f'{bucket}.json', name_shards[bucket])

    write_json(args.output / 'index.json', {str(asn): [old_index[str(asn)][0],
        membership[asn], old_index[str(asn)][1], degree[asn]] for asn in sorted(degree)})
    shards = defaultdict(dict)
    for asn in sorted(adjacency):
        shards[asn % 256][str(asn)] = {'neighbors': adjacency[asn]}
    for bucket in range(256):
        write_json(args.output / 'adj' / f'{bucket}.json', shards[bucket])
    write_json(args.output / 'overview.json', {
        'meta': topology['meta'],
        'groups': [{k: g[k] for k in ('id', 'label', 'seedAsn', 'asnCount', 'country')} for g in topology['groups']],
        'links': topology['links']})
    write_json(args.output / 'root.json', {
        'groups': [{'id': g['id'], 'label': g['label'], 'count': g['asnCount'],
            'seedAsn': g['seedAsn'], 'color': g['color']} for g in topology['groups']],
        'links': [{'source': a, 'target': b, 'count': n}
            for (a, b), n in sorted(root_edges.items())]})

    within_leaf = sum(len(v) for v in leaf_edges.values())
    between_leaf = sum(sum(v.values()) for v in group_tile_edges.values())
    between_group = sum(root_edges.values())
    assert within_leaf + between_leaf + between_group == len(edges)
    assert sum(len(v) for v in adjacency.values()) == 2 * len(edges)
    assert between_group == topology['meta']['betweenGroupLinks']
    files = sorted(args.output.rglob('*.json'))
    sizes = {str(p.relative_to(args.output)): p.stat().st_size for p in files}
    compressed = sum(len(gzip.compress(p.read_bytes(), compresslevel=6, mtime=0)) for p in files)
    manifest = {'schemaVersion': 1, 'snapshotDate': topology['meta']['date'],
        'source': topology['meta']['source'], 'rootGroups': len(group_nodes),
        'asnCount': len(degree), 'relationshipCount': len(edges),
        'directedAdjacencyEntries': sum(len(v) for v in adjacency.values()),
        'leafCount': len(leaf_members), 'targetLeafSize': args.target_size,
        'minLeafSize': min(map(len, leaf_members.values())),
        'maxLeafSize': max(map(len, leaf_members.values())),
        'withinLeafRelationships': within_leaf,
        'betweenLeavesWithinGroupRelationships': between_leaf,
        'betweenRootGroupRelationships': between_group,
        'adjacencyBucketCount': 256,
        'adjacencyBucketFormula': 'ASN % 256 (decimal filename)',
        'leafPartitionMethod': 'Deterministic descending-degree breadth-first traversal within each existing root community, divided into equally sized tiles of at most targetLeafSize. Tiles need not be connected; no links are invented.',
        'rootPartitionMethod': topology['meta']['grouping'],
        'layoutMethod': 'NetworkX spring layout, real edges only, 28 iterations, fixed seeds; normalized coordinates in [-1,1].',
        'nameSemantics': 'Tile label is its highest-degree ASN name; it is not ownership or geography.',
        'relationshipDirection': 'In leaf links, provider-customer source is provider and target is customer. Adjacency roles describe the neighbor relative to the queried ASN.',
        'allAsnsAssignedExactlyOnce': True, 'allRelationshipsPreserved': True,
        'totalJsonBytesExcludingManifest': sum(sizes.values()),
        'estimatedGzipBytesExcludingManifest': compressed,
        'largestFile': max(sizes, key=sizes.get), 'largestFileBytes': max(sizes.values()),
        'elapsedSeconds': round(time.monotonic() - started, 2), 'files': sizes}
    write_json(args.output / 'manifest.json', manifest)
    print(json.dumps({k: v for k, v in manifest.items() if k != 'files'}, indent=2))


if __name__ == '__main__':
    main()
