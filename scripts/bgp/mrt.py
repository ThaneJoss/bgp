"""Bounded streaming MRT TABLE_DUMP_V2 reader (RFC 6396 / RFC 6793).

Only IPv4/IPv6 unicast RIBs are exported. Structural corruption and unknown MRT
formats abort the build. Non-linear paths remain explicit unsupported routes,
so they still shadow less-specific routes during longest-prefix matching.
"""
from __future__ import annotations

import bz2
import gzip
import hashlib
import ipaddress
import json
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterator

MAX_MRT_RECORD = 64 * 1024 * 1024
MAX_PATH_ASNS = 256


class FormatError(ValueError):
    pass


@dataclass(frozen=True)
class Peer:
    asn: int
    address: str

    @property
    def id(self) -> str:
        return "p" + hashlib.sha256(f"{self.asn}|{self.address}".encode()).hexdigest()[:16]


@dataclass(frozen=True)
class Route:
    peer: Peer
    family: int
    start: bytes
    length: int
    flags: int
    path: bytes
    reason: str = ""


def open_input(path: Path) -> BinaryIO:
    if path.suffix == ".gz":
        return gzip.open(path, "rb")
    if path.suffix == ".bz2":
        return bz2.open(path, "rb")
    return path.open("rb")


class Cursor:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def take(self, count: int) -> bytes:
        end = self.pos + count
        if end > len(self.data):
            raise FormatError("Truncated MRT field")
        value = self.data[self.pos:end]
        self.pos = end
        return value

    def uint(self, count: int) -> int:
        return int.from_bytes(self.take(count), "big")

    def finish(self):
        if self.pos != len(self.data):
            raise FormatError("Unexpected trailing MRT bytes")


def segments(data: bytes, width: int = 4) -> list[tuple[int, list[int]]]:
    cursor = Cursor(data)
    result = []
    while cursor.pos < len(data):
        kind, count = cursor.uint(1), cursor.uint(1)
        if count == 0 or kind not in (1, 2, 3, 4):
            raise FormatError("Invalid AS_PATH segment")
        values = [cursor.uint(width) for _ in range(count)]
        result.append((kind, values))
    return result


def decode_attributes(data: bytes) -> tuple[int, bytes, str]:
    """TABLE_DUMP_V2 AS_PATH is always 4-byte, irrespective of peer ASN width.

    AS4_PATH only reconstructs a path containing AS_TRANS; a native 4-byte path
    is already authoritative. AS_SET/confederations are never flattened. In a
    transition path the RFC 6793 leading AS_PATH + AS4_PATH reconstruction is
    applied only for unambiguous all-AS_SEQUENCE paths. Remaining AS_TRANS is
    marked unsupported instead of being presented as a real AS hop.
    """
    cursor = Cursor(data)
    attributes: dict[int, bytes] = {}
    while cursor.pos < len(data):
        attr_flags, kind = cursor.uint(1), cursor.uint(1)
        size = cursor.uint(2 if attr_flags & 0x10 else 1)
        value = cursor.take(size)
        if kind in (2, 7, 17, 18):
            if kind in attributes:
                raise FormatError(f"Duplicate BGP path attribute {kind}")
            attributes[kind] = value
    if 2 not in attributes:
        return 2, b"", "missing_as_path"
    try:
        original = segments(attributes[2])
    except FormatError:
        return 2, b"", "malformed_as_path"
    if any(kind != 2 for kind, _ in original):
        return 2, b"", "non_linear_as_path"
    path = [asn for _, values in original for asn in values]
    if 23456 in path and 17 in attributes:
        # RFC 6793 4.2.3: an ordinary AGGREGATOR plus AS4_AGGREGATOR makes
        # AS4_PATH inapplicable. A V2 AGGREGATOR carries a 4-byte ASN.
        ignore_as4 = False
        if 7 in attributes and 18 in attributes:
            aggregator = attributes[7]
            if len(aggregator) != 8 or len(attributes[18]) != 8:
                return 2, b"", "malformed_aggregator"
            ignore_as4 = int.from_bytes(aggregator[:4], "big") != 23456
        if not ignore_as4:
            try:
                as4 = segments(attributes[17])
            except FormatError:
                return 2, b"", "malformed_as4_path"
            if any(kind != 2 for kind, _ in as4):
                return 2, b"", "non_linear_as4_path"
            replacement = [asn for _, values in as4 for asn in values]
            if replacement and len(replacement) <= len(path):
                path = path[:len(path) - len(replacement)] + replacement
    if not path:
        return 2, b"", "empty_as_path"
    if 0 in path or 23456 in path:
        return 2, b"", "unresolved_as_path"
    if len(path) > MAX_PATH_ASNS:
        raise FormatError(f"AS_PATH exceeds {MAX_PATH_ASNS} ASNs")
    return 1, struct.pack(f">{len(path)}I", *path), ""


def _peer_table(body: bytes) -> list[Peer]:
    cursor = Cursor(body)
    cursor.take(4)  # collector BGP ID
    cursor.take(cursor.uint(2))  # view name
    peers = []
    for _ in range(cursor.uint(2)):
        kind = cursor.uint(1)
        if kind & ~3:
            raise FormatError("Unknown PEER_INDEX_TABLE flags")
        cursor.take(4)  # peer BGP ID
        address = str(ipaddress.ip_address(cursor.take(16 if kind & 1 else 4)))
        asn = cursor.uint(4 if kind & 2 else 2)
        peers.append(Peer(asn, address))
    cursor.finish()
    if len({p.id for p in peers}) != len(peers):
        raise FormatError("Duplicate ASN/address peer sessions cannot be combined safely")
    return peers


def iter_mrt(path: Path, decode: bool = True, selected: set[str] | None = None) -> Iterator[Route]:
    peers = None
    with open_input(path) as stream:
        while True:
            header = stream.read(12)
            if not header:
                break
            if len(header) != 12:
                raise FormatError("Truncated MRT header")
            _, kind, subtype, length = struct.unpack(">IHHI", header)
            if kind != 13:
                raise FormatError(f"Only TABLE_DUMP_V2 is accepted, got MRT type {kind}")
            if length > MAX_MRT_RECORD:
                raise FormatError("MRT record exceeds 64 MiB safety bound")
            body = stream.read(length)
            if len(body) != length:
                raise FormatError("Truncated MRT record")
            if subtype == 1:
                if peers is not None:
                    raise FormatError("Multiple PEER_INDEX_TABLEs in one input are unsupported")
                peers = _peer_table(body)
                continue
            if peers is None:
                raise FormatError("RIB before PEER_INDEX_TABLE")
            if subtype in (3, 5, 9, 11):
                # Explicitly out of scope: IPv4/IPv6 multicast, including ADDPATH.
                continue
            if subtype not in (2, 4, 6, 8, 10, 12):
                raise FormatError(f"Unsupported TABLE_DUMP_V2 subtype {subtype}")
            cursor = Cursor(body)
            cursor.take(4)  # sequence number
            if subtype in (6, 12):
                afi, safi = cursor.uint(2), cursor.uint(1)
                if afi not in (1, 2) or safi != 1:
                    raise FormatError(f"Unsupported RIB_GENERIC AFI/SAFI {afi}/{safi}")
                family = 4 if afi == 1 else 6
                if subtype == 12:
                    cursor.take(4)  # RFC 8050 generic ADDPATH ID is part of NLRI.
            else:
                family = 4 if subtype in (2, 8) else 6
            bits = 32 if family == 4 else 128
            plen = cursor.uint(1)
            if plen > bits:
                raise FormatError("Invalid prefix length")
            raw = cursor.take((plen + 7) // 8)
            start = int.from_bytes(raw.ljust(bits // 8, b"\0"), "big")
            if plen < bits:
                start = (start >> (bits - plen)) << (bits - plen)
            start_bytes = start.to_bytes(16, "big")
            for _ in range(cursor.uint(2)):
                peer_index = cursor.uint(2)
                cursor.take(4)  # route originated time (not snapshot time)
                if subtype in (8, 10):
                    cursor.take(4)  # ADDPATH identifier; conflicting routes fail closed in builder.
                attributes = cursor.take(cursor.uint(2))
                if peer_index >= len(peers):
                    raise FormatError("RIB references unknown peer")
                peer = peers[peer_index]
                if selected is not None and peer.id not in selected:
                    continue
                flags, packed, reason = decode_attributes(attributes) if decode else (0, b"", "")
                yield Route(peer, family, start_bytes, plen, flags, packed, reason)
            cursor.finish()
    if peers is None:
        raise FormatError("No MRT PEER_INDEX_TABLE found")


def iter_jsonl(path: Path, decode: bool = True, selected: set[str] | None = None) -> Iterator[Route]:
    """Local fixture/import format; this function performs no network I/O."""
    with open_input(path) as stream:
        for line_no, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
                metadata = record["peer"]
                peer = Peer(int(metadata["asn"]), str(ipaddress.ip_address(metadata["address"])))
                if not 0 < peer.asn < 2**32:
                    raise ValueError("Invalid peer ASN")
                network = ipaddress.ip_network(record["prefix"], strict=True)
                if selected is not None and peer.id not in selected:
                    continue
                flags, packed, reason = 0, b"", ""
                if decode:
                    path_asns = record.get("path", [])
                    if record.get("unsupported"):
                        flags, reason = 2, "fixture_unsupported"
                    else:
                        if any(type(asn) is not int or not 0 < asn < 2**32 for asn in path_asns):
                            raise ValueError("Invalid path ASN")
                        if len(path_asns) > MAX_PATH_ASNS:
                            raise FormatError("AS_PATH exceeds 256 ASNs")
                        if not path_asns or 23456 in path_asns:
                            flags, reason = 2, "unresolved_as_path"
                        else:
                            flags = 1
                            packed = struct.pack(f">{len(path_asns)}I", *path_asns)
                yield Route(peer, network.version, int(network.network_address).to_bytes(16, "big"), network.prefixlen, flags, packed, reason)
            except (KeyError, TypeError, ValueError) as exc:
                raise FormatError(f"Invalid JSONL line {line_no}: {exc}") from exc


def iter_routes(path: Path, decode: bool = True, selected: set[str] | None = None) -> Iterator[Route]:
    names = path.name.removesuffix(".gz").removesuffix(".bz2")
    reader = iter_jsonl if names.endswith(".jsonl") else iter_mrt
    yield from reader(path, decode=decode, selected=selected)
