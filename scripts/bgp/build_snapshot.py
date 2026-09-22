#!/usr/bin/env python3
"""Build a local, bounded-query BGP snapshot without making network requests.

Two streaming passes: count peer coverage, then parse selected peer paths into
an on-disk SQLite table. A sorted prefix sweep compiles LPM intervals using at
most 129 active prefixes. See docs/bgp/format.md for the binary query contract.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import gzip
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import sqlite3
import struct
import tempfile
import time

from mrt import FormatError, Peer, iter_routes

PAGE_RECORDS = 1024
RECORD_BYTES = 24
MAX_INDEX_BYTES = 256 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
NONE = (0, b"", 0, 0)


def write_json(path: Path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def compact(value) -> bytes:
    return (json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def validate_time(value: str) -> str:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("--data-time must include a UTC offset")
    return parsed.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def choose_peers(input_path: Path, config: dict, requested_asn: int | None, scratch_dir: Path):
    peers, raw_counts = {}, collections.Counter()
    # ADDPATH may repeat the same prefix in one or several MRT records. Count
    # distinct prefixes on disk so duplicate paths cannot pass coverage gates.
    with tempfile.TemporaryDirectory(prefix="bgp-coverage-", dir=scratch_dir) as scratch:
        connection = sqlite3.connect(Path(scratch) / "coverage.sqlite")
        try:
            connection.execute("PRAGMA journal_mode=OFF")
            connection.execute("PRAGMA synchronous=OFF")
            connection.execute("PRAGMA temp_store=FILE")
            connection.execute("PRAGMA cache_size=-65536")
            connection.execute("CREATE TABLE prefixes(peer TEXT,family INTEGER,start BLOB,plen INTEGER,PRIMARY KEY(peer,family,start,plen)) WITHOUT ROWID")
            batch = []
            for route in iter_routes(input_path, decode=False):
                pid = route.peer.id
                peers[pid] = route.peer
                raw_counts[(pid, route.family)] += 1
                batch.append((pid, route.family, route.start, route.length))
                if len(batch) >= 5000:
                    connection.executemany("INSERT OR IGNORE INTO prefixes VALUES(?,?,?,?)", batch)
                    batch.clear()
            if batch:
                connection.executemany("INSERT OR IGNORE INTO prefixes VALUES(?,?,?,?)", batch)
            counts = collections.Counter({(pid, family): count for pid, family, count in connection.execute("SELECT peer,family,count(*) FROM prefixes GROUP BY peer,family")})
        finally:
            connection.close()
    selection = config.get("selection", {})
    maximum = int(selection.get("maxPeers", 3))
    if not 1 <= maximum <= 5:
        raise ValueError("selection.maxPeers must be between 1 and 5")
    thresholds = {4: int(selection.get("minPrefixes", {}).get("4", 800000)),
                  6: int(selection.get("minPrefixes", {}).get("6", 150000))}
    if any(value < 1 for value in thresholds.values()):
        raise ValueError("minPrefixes must be positive")
    preferred = [int(asn) for asn in selection.get("preferredAsns", [])]
    required = {int(f) for f in selection.get("requireFamilies", [4])}
    if not required <= {4, 6}:
        raise ValueError("requireFamilies accepts only 4 and 6")
    families = {pid: {family for family in (4, 6) if counts[(pid, family)] >= thresholds[family]} for pid in peers}
    allowed = {str(ipaddress.ip_address(address)) for address in selection.get("allowedPeerAddresses", [])}
    allowed_peers = {(int(p["asn"]), str(ipaddress.ip_address(p["address"])))
                     for p in selection.get("allowedPeers", [])}
    candidates = [pid for pid, p in peers.items() if families[pid]
                  and (requested_asn is None or p.asn == requested_asn)
                  and (not allowed or p.address in allowed)
                  and (not allowed_peers or (p.asn, p.address) in allowed_peers)]
    def rank(pid):
        peer = peers[pid]
        return (preferred.index(peer.asn) if peer.asn in preferred else len(preferred),
                -len(families[pid]), -sum(counts[(pid, f)] for f in families[pid]), pid)
    candidates.sort(key=rank)
    selected = candidates[:maximum]
    # Respect priority, while reserving a slot for a required family if needed.
    for family in sorted(required):
        if any(family in families[pid] for pid in selected):
            continue
        extra = next((pid for pid in candidates if family in families[pid]), None)
        if extra is None:
            raise ValueError(f"No full-table peer meets IPv{family} coverage threshold {thresholds[family]}")
        if len(selected) == maximum:
            replace = next((pid for pid in reversed(selected)
                            if all(any(f in families[other] for other in selected if other != pid) or f in families[extra]
                                   for f in required)), None)
            if replace is None:
                raise ValueError("maxPeers is too small to satisfy requireFamilies without joining sessions")
            selected.remove(replace)
        selected.append(extra)
    if not selected:
        raise ValueError("No peer session meets full-table coverage thresholds")
    selected.sort(key=rank)
    report = {"thresholds": {str(k): v for k, v in thresholds.items()}, "requiredFamilies": sorted(required),
              "peers": [{"id": pid, "asn": p.asn, "address": p.address,
                         "prefixCounts": {str(f): counts[(pid, f)] for f in (4, 6)},
                         "rawEntryCounts": {str(f): raw_counts[(pid, f)] for f in (4, 6)},
                         "eligibleFamilies": sorted(families[pid]), "selected": pid in selected}
                        for pid, p in sorted(peers.items())]}
    return [peers[pid] for pid in selected], families, thresholds, report


def create_database(path: Path):
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode=OFF")
    connection.execute("PRAGMA synchronous=OFF")
    connection.execute("PRAGMA temp_store=FILE")
    connection.execute("PRAGMA cache_size=-65536")
    connection.execute("CREATE TABLE routes(peer TEXT, family INTEGER, start BLOB, plen INTEGER, flags INTEGER, path BLOB, reason TEXT, PRIMARY KEY(peer,family,start,plen)) WITHOUT ROWID")
    connection.execute("CREATE TABLE path_offsets(peer TEXT, family INTEGER, path BLOB, offset INTEGER, PRIMARY KEY(peer,family,path)) WITHOUT ROWID")
    return connection


def ingest(connection, input_path: Path, peers: list[Peer], families: dict):
    reasons = collections.Counter()
    total = 0
    selected = {peer.id for peer in peers}
    statement = """INSERT INTO routes VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(peer,family,start,plen) DO UPDATE SET
        flags=CASE WHEN routes.flags=excluded.flags AND routes.path=excluded.path THEN routes.flags ELSE 2 END,
        path=CASE WHEN routes.flags=excluded.flags AND routes.path=excluded.path THEN routes.path ELSE X'' END,
        reason=CASE WHEN routes.flags=excluded.flags AND routes.path=excluded.path THEN routes.reason ELSE 'conflicting_paths' END"""
    batch = []
    for route in iter_routes(input_path, selected=selected):
        if route.family not in families[route.peer.id]:
            continue
        total += 1
        if route.reason:
            reasons[route.reason] += 1
        batch.append((route.peer.id, route.family, route.start, route.length, route.flags, route.path, route.reason))
        if len(batch) >= 5000:
            connection.executemany(statement, batch)
            batch.clear()
    if batch:
        connection.executemany(statement, batch)
    connection.commit()
    return total, reasons


def prefix_text(family, start, length):
    address = int.from_bytes(start, "big")
    cls = ipaddress.IPv4Network if family == 4 else ipaddress.IPv6Network
    return str(cls((address, length)))


def normalized_rows(connection, peers):
    lookup = {peer.id: peer for peer in peers}
    for pid, family, start, length, flags, path, reason in connection.execute("SELECT * FROM routes ORDER BY peer,family,start,plen"):
        peer = lookup[pid]
        yield {"peer": pid, "asn": peer.asn, "address": peer.address, "family": family,
               "prefix": prefix_text(family, start, length), "flags": flags,
               "path": [x[0] for x in struct.iter_unpack(">I", path)], "reason": reason}


def write_normalized(connection, peers, output: Path):
    with output.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as target:
        for route in normalized_rows(connection, peers):
            target.write(compact(route))


def route_key(route):
    network = ipaddress.ip_network(route["prefix"], strict=True)
    if route["family"] != network.version:
        raise ValueError("Normalized route family does not match prefix")
    return route["peer"], network.version, int(network.network_address), network.prefixlen


def read_normalized(path: Path):
    previous = None
    with gzip.open(path, "rb") as source:
        for line in source:
            route = json.loads(line)
            key = route_key(route)
            if previous is not None and key <= previous:
                raise ValueError("Previous normalized routes are not strictly sorted")
            previous = key
            yield key, route


def write_diff(current: Path, previous: Path | None, output: Path):
    stats = {"baseline": previous is None, "added": 0, "removed": 0, "changed": 0, "unchanged": 0}
    before = iter(read_normalized(previous)) if previous else iter(())
    after = iter(read_normalized(current))
    old, new = next(before, None), next(after, None)
    with output.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as target:
        while old is not None or new is not None:
            if new is None or (old is not None and old[0] < new[0]):
                kind, a, b = "removed", old[1], None
                old = next(before, None)
            elif old is None or new[0] < old[0]:
                kind, a, b = "added", None, new[1]
                new = next(after, None)
            else:
                a, b = old[1], new[1]
                kind = "unchanged" if a == b else "changed"
                old, new = next(before, None), next(after, None)
            stats[kind] += 1
            if kind != "unchanged":
                target.write(compact({"type": kind, "before": a, "after": b}))
    return stats


class IntervalWriter:
    def __init__(self, connection, peer: str, family: int, output: Path):
        self.connection, self.peer, self.family = connection, peer, family
        self.records = (output / f"v{family}.records.bin").open("wb")
        self.index = (output / f"v{family}.index.bin").open("wb")
        self.paths = (output / f"v{family}.paths.bin").open("wb")
        self.page, self.page_start = [], None
        self.count, self.index_count = 0, 0
        self.pending = None
        self.last_descriptor = None
        self.path_cache = collections.OrderedDict()

    def emit(self, start: int, descriptor):
        if self.pending is not None:
            if start < self.pending[0]:
                raise ValueError("Non-monotonic interval sweep")
            if start == self.pending[0]:
                self.pending = (start, descriptor)
                return
            self.flush_pending()
        self.pending = (start, descriptor)

    def path_offset(self, path: bytes):
        if not path:
            return 0
        cached = self.path_cache.get(path)
        if cached is not None:
            self.path_cache.move_to_end(path)
            return cached
        row = self.connection.execute("SELECT offset FROM path_offsets WHERE peer=? AND family=? AND path=?", (self.peer, self.family, path)).fetchone()
        if row:
            offset = row[0]
        else:
            offset = self.paths.tell()
            if offset + len(path) > 2**32 - 1:
                raise ValueError("Path file exceeds uint32 byte offset capacity")
            self.paths.write(path)
            self.connection.execute("INSERT INTO path_offsets VALUES(?,?,?,?)", (self.peer, self.family, path, offset))
        self.path_cache[path] = offset
        if len(self.path_cache) > 32768:
            self.path_cache.popitem(last=False)
        return offset

    def flush_pending(self):
        start, descriptor = self.pending
        # Prefix identity matters as well as path: adjacent /24s with the same
        # path must remain separate intervals so each interval stays inside its
        # winning prefix. The fourth field exists only during compilation.
        if descriptor == self.last_descriptor:
            return
        flags, path, plen, _network_start = descriptor
        if len(path) // 4 > 256:
            raise ValueError("Path exceeds query budget")
        packed = start.to_bytes(16, "big")
        record = packed + struct.pack(">IHBB", self.path_offset(path), len(path) // 4, plen, flags)
        if not self.page:
            self.page_start = packed
        self.page.append(record)
        self.last_descriptor = descriptor
        self.count += 1
        if len(self.page) == PAGE_RECORDS:
            self.flush_page()

    def flush_page(self):
        if not self.page:
            return
        if (self.index_count + 1) * RECORD_BYTES > MAX_INDEX_BYTES:
            raise ValueError("Index exceeds 256 KiB Worker query bound")
        offset = self.records.tell()
        if offset > 2**32 - 1:
            raise ValueError("Records exceed uint32 byte offset capacity")
        self.index.write(self.page_start + struct.pack(">IHH", offset, len(self.page), 0))
        self.records.write(b"".join(self.page))
        self.index_count += 1
        self.page.clear()

    def finish(self):
        try:
            if self.pending is not None:
                self.flush_pending()
            self.flush_page()
        finally:
            self.records.close()
            self.index.close()
            self.paths.close()
        return {"index": f"{self.peer}/v{self.family}.index.bin",
                "records": f"{self.peer}/v{self.family}.records.bin",
                "paths": f"{self.peer}/v{self.family}.paths.bin",
                "intervalCount": self.count, "indexCount": self.index_count}


def compile_family(connection, peer: Peer, family: int, output: Path):
    output.mkdir(exist_ok=True)
    writer = IntervalWriter(connection, peer.id, family, output)
    bits = 32 if family == 4 else 128
    limit = 1 << bits
    stack = []
    writer.emit(0, NONE)
    rows = connection.execute("SELECT start,plen,flags,path FROM routes WHERE peer=? AND family=? ORDER BY start,plen", (peer.id, family))
    try:
        for start_bytes, plen, flags, path in rows:
            start = int.from_bytes(start_bytes, "big")
            while stack and stack[-1][0] <= start:
                end, _ = stack.pop()
                if end < limit:
                    writer.emit(end, stack[-1][1] if stack else NONE)
            end = start + (1 << (bits - plen))
            if stack and end > stack[-1][0]:
                raise ValueError("CIDR intervals are not nested or disjoint")
            descriptor = (flags, path, plen, start)
            writer.emit(start, descriptor)
            stack.append((end, descriptor))
        while stack:
            end, _ = stack.pop()
            if end < limit:
                writer.emit(end, stack[-1][1] if stack else NONE)
        return writer.finish()
    except Exception:
        writer.records.close()
        writer.index.close()
        writer.paths.close()
        raise


def file_inventory(output: Path):
    files = []
    for path in sorted(output.rglob("*")):
        if path.is_file() and path.name not in ("manifest.json", "latest.json"):
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            files.append({"key": path.relative_to(output).as_posix(), "bytes": path.stat().st_size, "sha256": digest.hexdigest()})
    return files


def build(input_path: Path, output: Path, config: dict, snapshot_id: str, data_time: str,
          previous: Path | None = None, peer_asn: int | None = None,
          previous_snapshot_id: str | None = None):
    started = time.monotonic()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", snapshot_id):
        raise ValueError("Invalid snapshot ID")
    data_time = validate_time(data_time)
    if bool(previous) != bool(previous_snapshot_id):
        raise ValueError("--previous and --previous-snapshot-id must be provided together")
    if previous_snapshot_id is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", previous_snapshot_id):
        raise ValueError("Invalid previous snapshot ID")
    for key in ("id", "location", "sourceUrl"):
        if not isinstance(config.get(key), str) or not config[key]:
            raise ValueError(f"collector-config.{key} is required")
    if not config["sourceUrl"].startswith("https://"):
        raise ValueError("collector-config.sourceUrl must use https")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output directory must be empty to prevent stale files or manifest publication")
    output.mkdir(parents=True, exist_ok=True)
    peers, families, thresholds, report = choose_peers(input_path, config, peer_asn, output.parent)
    with tempfile.TemporaryDirectory(prefix="bgp-build-", dir=output.parent) as scratch:
        connection = create_database(Path(scratch) / "routes.sqlite")
        try:
            read_count, reasons = ingest(connection, input_path, peers, families)
            public_peers, route_count = [], 0
            for peer in peers:
                entry = {"id": peer.id, "asn": peer.asn, "address": peer.address, "label": f"AS{peer.asn} · {peer.address}", "families": {}}
                for family in sorted(families[peer.id]):
                    count = connection.execute("SELECT count(*) FROM routes WHERE peer=? AND family=?", (peer.id, family)).fetchone()[0]
                    if count < thresholds[family]:
                        raise ValueError(f"Peer {peer.id} IPv{family} has only {count} unique prefixes; coverage gate failed")
                    spec = compile_family(connection, peer, family, output / peer.id)
                    spec["prefixCount"] = count
                    entry["families"][str(family)] = spec
                    route_count += count
                public_peers.append(entry)
            actual_reasons = {reason: count for reason, count in connection.execute("SELECT reason,count(*) FROM routes WHERE flags=2 GROUP BY reason")}
            write_normalized(connection, peers, output / "normalized.jsonl.gz")
            changes = write_diff(output / "normalized.jsonl.gz", previous, output / "diff.jsonl.gz")
        finally:
            connection.close()
    write_json(output / "selection.json", report)
    manifest = {"schemaVersion": 1, "snapshotId": snapshot_id, "previousSnapshotId": previous_snapshot_id,
                "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
                "dataTime": data_time,
                "collector": {key: config[key] for key in ("id", "location", "sourceUrl")},
                "defaultPeer": peers[0].id, "peers": public_peers,
                "normalizedRoutes": "normalized.jsonl.gz", "diff": "diff.jsonl.gz",
                "files": file_inventory(output),
                "statistics": {"selectedPeers": len(peers), "inputRouteEntries": read_count,
                               "uniquePrefixes": route_count, "unsupportedReasons": actual_reasons,
                               "diff": changes, "buildSeconds": round(time.monotonic() - started, 3),
                               "inputPasses": 2, "selectionReport": "selection.json"}}
    encoded = compact(manifest)
    if len(encoded) > MAX_MANIFEST_BYTES:
        raise ValueError("Manifest exceeds 64 KiB Worker query bound")
    # Only complete builds get manifests. Publisher uploads immutable files
    # first and uses latest.json as the final atomic version switch.
    (output / "manifest.json").write_bytes(encoded)
    (output / "latest.json").write_bytes(encoded)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Local .mrt[.gz/.bz2] or .jsonl[.gz]")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--collector-config", "--config", required=True, type=Path)
    parser.add_argument("--snapshot-id", required=True)
    parser.add_argument("--data-time", required=True)
    parser.add_argument("--previous", type=Path, help="Previous normalized.jsonl.gz for a streaming diff")
    parser.add_argument("--previous-snapshot-id", help="ID belonging to --previous normalized routes")
    parser.add_argument("--peer-asn", type=int, help="Restrict eligible sessions to this ASN; coverage still enforced")
    args = parser.parse_args()
    try:
        manifest = build(args.input, args.output, json.loads(args.collector_config.read_text()), args.snapshot_id,
                         args.data_time, args.previous, args.peer_asn, args.previous_snapshot_id)
    except (OSError, ValueError, sqlite3.Error) as exc:
        parser.exit(1, f"BGP build refused: {exc}\n")
    print(json.dumps({"snapshotId": manifest["snapshotId"], "statistics": manifest["statistics"]}, indent=2))


if __name__ == "__main__":
    main()
