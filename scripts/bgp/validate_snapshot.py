#!/usr/bin/env python3
"""Validate a local snapshot's hashes and bounded Worker index contract; no network."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import ipaddress
import json
from pathlib import Path, PurePosixPath
import re
import struct
import urllib.parse

MANIFEST_LIMIT = 65536
INDEX_LIMIT = 262144
SNAPSHOT_RE = re.compile(r"^\d{8}T\d{6}Z$")


def snapshot_id(value: str) -> str:
    if not isinstance(value, str) or not SNAPSHOT_RE.fullmatch(value):
        raise ValueError("Invalid snapshot ID")
    dt.datetime.strptime(value, "%Y%m%dT%H%M%SZ")
    return value


def safe_key(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 160:
        raise ValueError("Invalid object key")
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value or any(part in (".", "..") for part in path.parts):
        raise ValueError("Object keys must be canonical relative paths")
    if not re.fullmatch(r"[A-Za-z0-9_.\-/]+", value):
        raise ValueError("Object key contains unsupported characters")
    return value


def load_manifest(raw: bytes, max_snapshot_bytes: int = 2 * 1024**3) -> dict:
    if len(raw) > MANIFEST_LIMIT:
        raise ValueError("Manifest exceeds the 64 KiB query limit")
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        raise ValueError("Unsupported manifest schema")
    snapshot_id(data.get("snapshotId"))
    for field in ("dataTime", "generatedAt"):
        if not isinstance(data.get(field), str) or not 1 <= len(data[field]) <= 40:
            raise ValueError(f"Invalid {field}")
        value = dt.datetime.fromisoformat(data[field].replace("Z", "+00:00"))
        if value.tzinfo is None:
            raise ValueError(f"{field} must include a timezone")
    expected_time = dt.datetime.strptime(data["snapshotId"], "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
    if dt.datetime.fromisoformat(data["dataTime"].replace("Z", "+00:00")) != expected_time:
        raise ValueError("Snapshot ID and dataTime do not match")
    collector = data.get("collector", {})
    for field, maximum in (("id", 64), ("location", 160), ("sourceUrl", 512)):
        if not isinstance(collector.get(field), str) or not 1 <= len(collector[field]) <= maximum:
            raise ValueError("Invalid collector metadata")
    source = urllib.parse.urlsplit(collector["sourceUrl"])
    if source.scheme != "https" or not source.hostname or source.username or source.password:
        raise ValueError("Collector source must be an HTTPS URL without credentials")
    files = data.get("files", [])
    if not isinstance(files, list) or not 1 <= len(files) <= 33:
        raise ValueError("Snapshot must list between 1 and 33 packed objects")
    inventory = {}
    for item in files:
        key = safe_key(item["key"])
        if key not in ("normalized.jsonl.gz", "diff.jsonl.gz", "selection.json") and not re.fullmatch(
                r"(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\.(?:index|records|paths)\.bin", key):
            raise ValueError("Object key does not match the Worker file contract")
        if key in inventory or key in ("manifest.json", "latest.json"):
            raise ValueError("Duplicate or reserved object key")
        if type(item["bytes"]) is not int or not 0 <= item["bytes"] <= 1024**3:
            raise ValueError("Invalid object size or object exceeds 1 GiB")
        if not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]):
            raise ValueError("Invalid SHA-256 digest")
        inventory[key] = item
    if sum(item["bytes"] for item in files) > max_snapshot_bytes:
        raise ValueError("Snapshot exceeds configured storage budget")
    peers = data.get("peers", [])
    if not isinstance(peers, list) or not 1 <= len(peers) <= 5:
        raise ValueError("Snapshot must contain 1 to 5 peer sessions")
    peer_ids = set()
    for peer in peers:
        peer_id = peer["id"]
        if not isinstance(peer_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", peer_id) or peer_id in peer_ids:
            raise ValueError("Invalid or duplicate peer ID")
        peer_ids.add(peer_id)
        if type(peer.get("asn")) is not int or not 1 <= peer["asn"] <= 0xffffffff:
            raise ValueError("Peer ASN must be a nonzero uint32")
        if not isinstance(peer.get("label"), str) or not 1 <= len(peer["label"]) <= 160:
            raise ValueError("Peer label is invalid")
        if not isinstance(peer.get("address"), str) or not 1 <= len(peer["address"]) <= 45:
            raise ValueError("Peer address is invalid")
        ipaddress.ip_address(peer["address"])
        if not isinstance(peer.get("families"), dict) or not peer["families"]:
            raise ValueError("Peer has no observed address families")
        for family, table in peer["families"].items():
            if family not in ("4", "6"):
                raise ValueError("Unknown address family")
            for field in ("index", "records", "paths"):
                if table[field] not in inventory:
                    raise ValueError("Family references an unlisted object")
            if len({table["index"], table["records"], table["paths"]}) != 3:
                raise ValueError("Family file references must be distinct")
            for count in ("indexCount", "intervalCount", "prefixCount"):
                if type(table.get(count)) is not int or not 1 <= table[count] <= 0xffffffff:
                    raise ValueError(f"Invalid family {count}")
            index_bytes = inventory[table["index"]]["bytes"]
            record_bytes = inventory[table["records"]]["bytes"]
            path_bytes = inventory[table["paths"]]["bytes"]
            if not 24 <= index_bytes <= INDEX_LIMIT or index_bytes % 24:
                raise ValueError("Index violates the Worker byte limit or record alignment")
            if record_bytes < 24 or record_bytes % 24 or path_bytes % 4:
                raise ValueError("Invalid records/path alignment")
            if table["indexCount"] != index_bytes // 24 or table["intervalCount"] != record_bytes // 24:
                raise ValueError("Index/interval counts differ from declared object sizes")
            if table["indexCount"] != (table["intervalCount"] + 1023) // 1024:
                raise ValueError("Index page count does not match the interval count")
    if data.get("defaultPeer") not in peer_ids:
        raise ValueError("Default peer is absent")
    for field in ("normalizedRoutes", "diff"):
        if data.get(field) not in inventory:
            raise ValueError(f"{field} must reference an inventoried object")
    if data.get("previousSnapshotId") is not None:
        if snapshot_id(data["previousSnapshotId"]) >= data["snapshotId"]:
            raise ValueError("Previous snapshot must predate this snapshot")
    return data


def file_hash(path: Path, algorithm: str = "sha256") -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate(directory: Path, config: dict | None = None) -> dict:
    config = config or {}
    limits = config.get("publish", {})
    raw = (directory / "manifest.json").read_bytes()
    manifest = load_manifest(raw, int(limits.get("maxSnapshotBytes", 2 * 1024**3)))
    root = directory.resolve()
    for item in manifest["files"]:
        path = directory / item["key"]
        if not path.resolve().is_relative_to(root) or path.is_symlink() or not path.is_file():
            raise ValueError("Snapshot file is missing or leaves the output directory")
        if path.stat().st_size != item["bytes"] or file_hash(path) != item["sha256"]:
            raise ValueError(f"Size/hash mismatch for {item['key']}")
    inventory = {item["key"]: item for item in manifest["files"]}
    for field, setting, default in (("normalizedRoutes", "maxNormalizedBytes", 1024**3), ("diff", "maxDiffBytes", 256 * 1024**2)):
        if inventory[manifest[field]]["bytes"] > int(limits.get(setting, default)):
            raise ValueError(f"{field} exceeds configured storage budget")
    for peer in manifest["peers"]:
        for family, table in peer["families"].items():
            index = (directory / table["index"]).read_bytes()
            prior = -1
            offset = 0
            previous_address = -1
            previous_prefix_end = None
            address_maximum = (1 << (128 if family == "6" else 32)) - 1
            paths_size = inventory[table["paths"]]["bytes"]
            with (directory / table["records"]).open("rb") as records:
                for start, page_offset, count, reserved in struct.iter_unpack(">16sIHH", index):
                    address = int.from_bytes(start, "big")
                    remaining = table["intervalCount"] - offset // 24
                    if address <= prior or (offset == 0 and address != 0) or page_offset != offset:
                        raise ValueError("Index ordering, zero sentinel, or page offsets are invalid")
                    if family == "4" and address >= 2**32:
                        raise ValueError("IPv4 index has a non-IPv4 address")
                    if reserved or count != min(1024, remaining):
                        raise ValueError("Invalid index page length or reserved flags")
                    page = records.read(count * 24)
                    if len(page) != count * 24 or page[:16] != start:
                        raise ValueError("Index and records disagree on page start")
                    for raw_address, path_offset, length, prefix, flags in struct.iter_unpack(">16sIHBB", page):
                        record_address = int.from_bytes(raw_address, "big")
                        if record_address <= previous_address or record_address > address_maximum:
                            raise ValueError("Record addresses are unordered or outside their address family")
                        if previous_prefix_end is not None and record_address > previous_prefix_end + 1:
                            raise ValueError("An interval extends beyond its winning prefix")
                        if flags not in (0, 1, 2) or prefix > (32 if family == "4" else 128):
                            raise ValueError("Invalid record flags or prefix length")
                        if length > 256 or path_offset % 4 or path_offset + length * 4 > paths_size:
                            raise ValueError("Invalid record path length or offset")
                        if (flags in (0, 2) and (length or path_offset)) or (flags == 1 and not length):
                            raise ValueError("Record flags and path metadata disagree")
                        width = (32 if family == "4" else 128) - prefix
                        previous_prefix_end = ((record_address >> width) + 1) * (1 << width) - 1 if flags else None
                        previous_address = record_address
                    offset += count * 24
                    prior = address
            if offset != inventory[table["records"]]["bytes"]:
                raise ValueError("Index does not cover every record")
            if previous_prefix_end is not None and previous_prefix_end != address_maximum:
                raise ValueError("Last routed interval needs a no-route sentinel before address-space end")
            with (directory / table["paths"]).open("rb") as paths:
                for block in iter(lambda: paths.read(1024 * 1024), b""):
                    if any(asn == 0 for (asn,) in struct.iter_unpack(">I", block)):
                        raise ValueError("AS paths cannot contain ASN zero")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=Path("config/bgp-collector.json"))
    args = parser.parse_args()
    manifest = validate(args.directory, json.loads(args.config.read_text()))
    print(f"Validated {manifest['snapshotId']}: {len(manifest['files'])} objects, "
          f"{sum(item['bytes'] for item in manifest['files'])} bytes")


if __name__ == "__main__":
    main()
