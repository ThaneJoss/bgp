export const COLLECTOR = { id: 'hkix.hkg', location: 'Hong Kong, HKIX' };
export const ALLOWED_PEERS = [
  { asn: 3491, address: '123.255.90.244' },
  { asn: 3491, address: '2001:7fa:0:1::ca28:a0f4' },
];
export const MAX_DOWNLOAD_BYTES = 1024 ** 3;

export function defaultSnapshotDate(now = new Date()) {
  return new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
}

export function snapshotSource(date, now = new Date()) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('请选择有效的 UTC 日期。');
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ||
      date < '2000-01-01' || date > now.toISOString().slice(0, 10)) {
    throw new Error('快照日期无效或晚于今天（UTC）。');
  }
  const stamp = date.replaceAll('-', '');
  return {
    snapshotId: `${stamp}T000000Z`, dataTime: `${date}T00:00:00Z`,
    filename: `rib.${stamp}.0000.bz2`,
    url: `https://archive.routeviews.org/hkix.hkg/bgpdata/${date.slice(0, 7).replace('-', '.')}/RIBS/rib.${stamp}.0000.bz2`,
  };
}
