"""Synthetic-only correctness checks; no test fetches network BGP data."""
import bisect
import bz2
import gzip
import hashlib
import ipaddress
import json
from pathlib import Path
import random
import struct
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "bgp"))
from build_snapshot import build
from mrt import FormatError, Peer, decode_attributes, iter_routes
from validate_snapshot import validate

FIXTURES = Path(__file__).parent / "fixtures"
NOW = "2026-09-22T00:00:00Z"


def attribute(kind, data):
    return bytes([0x50, kind]) + struct.pack(">H", len(data)) + data


def sequence(asns, kind=2):
    return bytes([kind, len(asns)]) + struct.pack(f">{len(asns)}I", *asns)


def record(subtype, data):
    return struct.pack(">IHHI", 1790035200, 13, subtype, len(data)) + data


def peer_table(asn=3491, address="192.0.2.1", asn4=False):
    packed = ipaddress.ip_address(address).packed
    flags = (1 if len(packed) == 16 else 0) | (2 if asn4 else 0)
    body = bytes(4) + bytes(2) + struct.pack(">H", 1)
    body += bytes([flags]) + bytes(4) + packed + asn.to_bytes(4 if asn4 else 2, "big")
    return record(1, body)


def rib(prefix, attrs, addpath=False, generic=False):
    network = ipaddress.ip_network(prefix)
    family = network.version
    subtype = (8 if family == 4 else 10) if addpath else (2 if family == 4 else 4)
    body = bytes(4)
    if generic:
        subtype = 12 if addpath else 6
        body += struct.pack(">HB", 1 if family == 4 else 2, 1)
        if addpath:
            body += struct.pack(">I", 123)
    body += bytes([network.prefixlen]) + network.network_address.packed[:(network.prefixlen + 7) // 8]
    body += struct.pack(">H", 1) + struct.pack(">HI", 0, 1790035000)
    if addpath and not generic:
        body += struct.pack(">I", 123)
    body += struct.pack(">H", len(attrs)) + attrs
    return record(subtype, body)


def lookup(output, manifest, ip, peer=None):
    address = ipaddress.ip_address(ip)
    metadata = next(p for p in manifest["peers"] if p["id"] == (peer or manifest["defaultPeer"]))
    spec = metadata["families"].get(str(address.version))
    if spec is None:
        return None
    index = (output / spec["index"]).read_bytes()
    page_starts = [int.from_bytes(index[i:i+16], "big") for i in range(0, len(index), 24)]
    page = bisect.bisect_right(page_starts, int(address)) - 1
    offset, count, reserved = struct.unpack_from(">IHH", index, page * 24 + 16)
    assert reserved == 0
    with (output / spec["records"]).open("rb") as file:
        file.seek(offset)
        data = file.read(count * 24)
    starts = [int.from_bytes(data[i:i+16], "big") for i in range(0, len(data), 24)]
    found = bisect.bisect_right(starts, int(address)) - 1
    path_offset, path_count, plen, flags = struct.unpack_from(">IHBB", data, found * 24 + 16)
    with (output / spec["paths"]).open("rb") as file:
        file.seek(path_offset)
        path = list(struct.unpack(f">{path_count}I", file.read(path_count * 4)))
    return flags, plen, path


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = json.loads((FIXTURES / "collector.json").read_text())

    def tearDown(self):
        self.temp.cleanup()

    def run_build(self, source=None, name="snapshot", **kwargs):
        output = self.root / name
        manifest = build(source or FIXTURES / "routes.jsonl", output, self.config, name, NOW, **kwargs)
        return output, manifest

    def test_lpm_unsupported_shadows_and_parent_restores(self):
        output, manifest = self.run_build()
        self.assertEqual(lookup(output, manifest, "10.1.1.1"), (1, 16, [3491, 64501, 64501]))
        self.assertEqual(lookup(output, manifest, "10.1.2.1"), (2, 24, []))
        self.assertEqual(lookup(output, manifest, "10.1.2.129"), (1, 25, [3491, 4200000000]))
        self.assertEqual(lookup(output, manifest, "10.1.3.1"), (1, 16, [3491, 64501, 64501]))
        self.assertEqual(lookup(output, manifest, "10.2.0.1"), (1, 8, [3491, 64500]))
        self.assertEqual(lookup(output, manifest, "11.0.0.0"), (0, 0, []))
        self.assertEqual(lookup(output, manifest, "0.0.0.0"), (0, 0, []))
        self.assertEqual(lookup(output, manifest, "255.255.255.255"), (0, 0, []))
        self.assertEqual(lookup(output, manifest, "2001:db8::1"), (1, 32, [3491, 64502]))
        other = next(peer for peer in manifest["peers"] if peer["address"] != "192.0.2.1")
        self.assertIsNone(lookup(output, manifest, "10.0.0.1", other["id"]))
        for entry in manifest["files"]:
            data = (output / entry["key"]).read_bytes()
            self.assertEqual(len(data), entry["bytes"])
            self.assertEqual(hashlib.sha256(data).hexdigest(), entry["sha256"])
        self.assertFalse(any(output.glob("*.sqlite")))

    def test_default_route_and_ipv6_endpoints(self):
        source = self.root / "defaults.jsonl"
        source.write_text("\n".join(json.dumps({"peer": {"asn": 3491, "address": "192.0.2.1"}, "prefix": prefix, "path": path}) for prefix, path in [
            ("0.0.0.0/0", [3491]), ("255.255.255.255/32", [3491, 65536]),
            ("::/0", [3491]), ("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128", [3491, 4200000000])]))
        output, manifest = self.run_build(source)
        self.assertEqual(lookup(output, manifest, "0.0.0.0"), (1, 0, [3491]))
        self.assertEqual(lookup(output, manifest, "255.255.255.255"), (1, 32, [3491, 65536]))
        self.assertEqual(lookup(output, manifest, "::"), (1, 0, [3491]))
        self.assertEqual(lookup(output, manifest, "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), (1, 128, [3491, 4200000000]))

    def test_adjacent_identical_paths_preserve_prefix_boundaries(self):
        source = self.root / "adjacent.jsonl"
        prefixes = ["10.0.0.0/24", "10.0.1.0/24", "2001:db8::/128", "2001:db8::1/128"]
        source.write_text("\n".join(json.dumps({"peer": {"asn": 3491, "address": "192.0.2.1"},
                                                 "prefix": prefix, "path": [3491, 64500]})
                                    for prefix in prefixes))
        output, manifest = self.run_build(source, name="20260922T000000Z")
        for family in (4, 6):
            spec = manifest["peers"][0]["families"][str(family)]
            records = (output / spec["records"]).read_bytes()
            starts = {int.from_bytes(record[0], "big") for record in struct.iter_unpack(">16sIHBB", records)}
            for prefix in prefixes:
                network = ipaddress.ip_network(prefix)
                if network.version == family:
                    self.assertIn(int(network.network_address), starts)
                    self.assertEqual(lookup(output, manifest, str(network.network_address)),
                                     (1, network.prefixlen, [3491, 64500]))
            paths = (output / spec["paths"]).read_bytes()
            self.assertEqual(paths, struct.pack(">II", 3491, 64500))
        self.assertEqual(lookup(output, manifest, "10.0.1.255"), (1, 24, [3491, 64500]))
        self.assertEqual(lookup(output, manifest, "2001:db8::2"), (0, 0, []))
        validate(output, self.config)

    def test_mrt_width_addpath_as_set_and_ipv6(self):
        data = peer_table(asn4=False)  # AS_PATH stays four-byte despite two-byte peer ASN.
        data += rib("10.0.0.0/8", attribute(2, sequence([3491, 4200000000])))
        data += rib("10.1.0.0/16", attribute(2, sequence([3491]) + sequence([64500, 64501], 1)))
        data += rib("10.2.0.0/16", attribute(2, sequence([3491, 64500])), addpath=True)
        data += rib("10.2.0.0/16", attribute(2, sequence([3491, 64501])), addpath=True)
        data += rib("2001:db8::/32", attribute(2, sequence([3491, 65536])), generic=True, addpath=True)
        for extension, encoded in [("mrt", data), ("mrt.gz", gzip.compress(data)), ("mrt.bz2", bz2.compress(data))]:
            source = self.root / ("input." + extension)
            source.write_bytes(encoded)
            output, manifest = self.run_build(source, name=extension.replace(".", "_"))
            self.assertEqual(lookup(output, manifest, "10.0.0.1"), (1, 8, [3491, 4200000000]))
            self.assertEqual(lookup(output, manifest, "10.1.1.1"), (2, 16, []))
            self.assertEqual(lookup(output, manifest, "10.2.1.1"), (2, 16, []))
            self.assertEqual(lookup(output, manifest, "2001:db8::1"), (1, 32, [3491, 65536]))
            self.assertEqual(manifest["statistics"]["unsupportedReasons"]["conflicting_paths"], 1)

    def test_four_byte_asn_ipv6_peer_and_plain_generic_rib(self):
        source = self.root / "as4-peer.mrt"
        source.write_bytes(peer_table(asn=4200000000, address="2001:db8::a", asn4=True)
                           + rib("192.0.2.0/24", attribute(2, sequence([4200000000, 64500])), generic=True))
        output, manifest = self.run_build(source)
        self.assertEqual(manifest["peers"][0]["asn"], 4200000000)
        self.assertEqual(manifest["peers"][0]["address"], "2001:db8::a")
        self.assertEqual(lookup(output, manifest, "192.0.2.1"), (1, 24, [4200000000, 64500]))

    def test_as4_transition_and_native_path(self):
        attrs = attribute(2, sequence([3491, 23456, 64501])) + attribute(17, sequence([4200000000, 64501]))
        flag, packed, reason = decode_attributes(attrs)
        self.assertEqual((flag, list(struct.unpack(">3I", packed)), reason), (1, [3491, 4200000000, 64501], ""))
        native = attribute(2, sequence([3491, 4200000000])) + attribute(17, sequence([64501]))
        self.assertEqual(struct.unpack(">2I", decode_attributes(native)[1]), (3491, 4200000000))
        unresolved = attribute(2, sequence([3491, 23456])) + attribute(17, sequence([64500, 64501, 64502]))
        self.assertEqual(decode_attributes(unresolved)[0], 2)
        confed = attribute(2, sequence([3491], 3))
        self.assertEqual(decode_attributes(confed)[0], 2)

    def test_malformed_input_and_coverage_abort_without_manifest(self):
        source = self.root / "bad.mrt"
        source.write_bytes(peer_table() + rib("10.0.0.0/8", attribute(2, sequence([3491])))[:-1])
        with self.assertRaises(FormatError):
            self.run_build(source)
        self.assertFalse((self.root / "snapshot" / "latest.json").exists())
        self.config["selection"]["minPrefixes"]["4"] = 800000
        with self.assertRaisesRegex(ValueError, "coverage threshold"):
            self.run_build(name="coverage")
        self.assertFalse((self.root / "coverage" / "latest.json").exists())

    def test_peer_pinning_and_family_gate(self):
        self.config["selection"]["allowedPeerAddresses"] = ["2001:db8::1"]
        with self.assertRaisesRegex(ValueError, "IPv4"):
            self.run_build()
        self.config["selection"]["requireFamilies"] = [6]
        output, manifest = self.run_build(name="pinned")
        self.assertEqual([p["address"] for p in manifest["peers"]], ["2001:db8::1"])
        self.assertIsNone(lookup(output, manifest, "1.1.1.1"))

    def test_duplicate_paths_do_not_inflate_peer_coverage(self):
        self.config["selection"].update({"maxPeers": 1, "preferredAsns": [3491], "minPrefixes": {"4": 2, "6": 1}})
        source = self.root / "duplicates.jsonl"
        records = [
            {"peer": {"asn":3491,"address":"192.0.2.1"}, "prefix":"10.0.0.0/8", "path":[3491,64500]},
            {"peer": {"asn":3491,"address":"192.0.2.1"}, "prefix":"10.0.0.0/8", "path":[3491,64501]},
            {"peer": {"asn":64501,"address":"192.0.2.2"}, "prefix":"10.0.0.0/8", "path":[64501]},
            {"peer": {"asn":64501,"address":"192.0.2.2"}, "prefix":"11.0.0.0/8", "path":[64501]}]
        source.write_text("\n".join(json.dumps(value) for value in records))
        output, manifest = self.run_build(source)
        self.assertEqual(manifest["peers"][0]["asn"], 64501)
        report = json.loads((output / "selection.json").read_text())
        rejected = next(peer for peer in report["peers"] if peer["asn"] == 3491)
        self.assertEqual(rejected["prefixCounts"]["4"], 1)
        self.assertEqual(rejected["rawEntryCounts"]["4"], 2)

    def test_pinned_asn_must_match_address(self):
        self.config["selection"]["allowedPeers"] = [{"asn": 64599, "address": "192.0.2.1"}]
        with self.assertRaisesRegex(ValueError, "coverage threshold"):
            self.run_build()

    def test_streaming_diff_and_stable_peer_ids(self):
        output1, first = self.run_build(name="day1")
        lines = (FIXTURES / "routes.jsonl").read_text().splitlines()
        changed = json.loads(lines[0]); changed["path"] = [3491, 64599]
        source = self.root / "changed.jsonl"
        source.write_text("\n".join([json.dumps(changed), *lines[2:], json.dumps({"peer": {"asn":3491,"address":"192.0.2.1"},"prefix":"192.0.2.0/24","path":[3491,64598]})]))
        output2, second = self.run_build(source, name="day2", previous=output1 / "normalized.jsonl.gz", previous_snapshot_id="day1")
        self.assertEqual(first["defaultPeer"], second["defaultPeer"])
        self.assertEqual(second["previousSnapshotId"], "day1")
        self.assertEqual(second["statistics"]["diff"], {"baseline":False,"added":1,"removed":1,"changed":1,"unchanged":4})
        changes = [json.loads(line) for line in gzip.open(output2 / "diff.jsonl.gz", "rt")]
        self.assertEqual(sorted(change["type"] for change in changes), ["added", "changed", "removed"])

    def test_multiple_pages_and_random_lpm_oracle(self):
        rng = random.Random(6396)
        networks = {ipaddress.ip_network(f"10.{i//256}.{i%256}.0/24"): [3491, 64500+i] for i in range(1300)}
        networks[ipaddress.ip_network("10.0.0.0/8")] = [3491]
        networks[ipaddress.ip_network("10.0.0.0/16")] = [3491, 65001]
        source = self.root / "pages.jsonl"
        entries = list(networks.items()); rng.shuffle(entries)
        source.write_text("\n".join(json.dumps({"peer":{"asn":3491,"address":"192.0.2.1"},"prefix":str(net),"path":path}) for net,path in entries))
        output, manifest = self.run_build(source)
        family = manifest["peers"][0]["families"]["4"]
        self.assertGreater(family["indexCount"], 1)
        samples = [rng.randrange(2**32) for _ in range(150)] + [int(ipaddress.ip_address("10.0.0.0")) + rng.randrange(2**24) for _ in range(250)]
        samples += [int(net.network_address) for net in list(networks)[:20]]
        for integer in samples:
            address = ipaddress.IPv4Address(integer)
            matches = [net for net in networks if address in net]
            expected = (0,0,[]) if not matches else (1, max(matches,key=lambda net:net.prefixlen).prefixlen, networks[max(matches,key=lambda net:net.prefixlen)])
            self.assertEqual(lookup(output, manifest, str(address)), expected, str(address))


if __name__ == "__main__":
    unittest.main()
