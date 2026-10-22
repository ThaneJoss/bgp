import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compress } from '../bgp/fixtures.mjs';

export const relationshipsFilename = '20260901.as-rel.txt.bz2';
export const organizationsFilename = '20261001.as-org2info.txt.gz';
// First occurrence of each undirected pair is authoritative, including loops.
export const uniqueRelationships = [
  [1, 2, -1], [1, 3, 0], [2, 3, 0], [3, 4, -1],
  [4, 5, -1], [4, 6, 0], [5, 6, 0], [6, 6, 0], [7, 7, -1],
];
export const relationshipRows = [...uniqueRelationships, [2, 1, 0], [6, 5, -1], [3, 4, -1]];
export const relationshipText = rows => [
  '# input clique: 1 2 3', '# source:topology|BGP|20260901',
  '# source:topology|BGP|20260831', ...rows.map(row => row.join('|')), '',
].join('\n');

export async function temporaryDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), 'bgp-data-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

export async function writeRelationships(dataDir, rows = relationshipRows) {
  await writeFile(join(dataDir, relationshipsFilename), compress(Buffer.from(relationshipText(rows))));
}

export async function sourceFixture(t) {
  const dataDir = await temporaryDirectory(t);
  await writeRelationships(dataDir);
  const organizations = [
    '# format:org_id|changed|org_name|country|source',
    'org-a|20261001|Alpha Réseau|FR|test', 'org-b|20261001|Beta Networks|US|test',
    '# format:aut|changed|aut_name|org_id|source',
    '1|20261001|Transit α|org-a|test', '2|20261001|Alpha Edge|org-a|test',
    '3|20261001|Alpha Access|org-a|test', '4|20261001|MissingOrgAS|absent-org|test',
    '5|20261001|Beta Transit|org-b|test', '6|20261001|Beta Edge|org-b|test', '',
  ].join('\r\n');
  await writeFile(join(dataDir, organizationsFilename), compress(Buffer.from(organizations), 'gzip'));
  const source = (filename, snapshotDate) => ({
    filename, snapshotDate, url: `https://data.caida.org/test/${filename}`,
    fetchedAt: '2026-10-02T03:04:05.000Z',
  });
  await writeFile(join(dataDir, 'sources.json'), JSON.stringify({
    relationships: source(relationshipsFilename, '2026-09-01'),
    organizations: source(organizationsFilename, '2026-10-01'),
  }));
  return dataDir;
}

export const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

export async function jsonFiles(directory, prefix = '') {
  const files = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(files, await jsonFiles(directory, relative));
    else if (entry.name.endsWith('.json')) files[relative] = await readJson(join(directory, relative));
  }
  return files;
}
