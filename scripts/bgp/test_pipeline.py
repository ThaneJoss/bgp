"""Synthetic tests only. Network and R2 are replaced with in-memory adapters."""
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest

from download_snapshot import OFFICIAL_BASE, download, snapshot_metadata
from publish_snapshot import fetch_previous, publish
from validate_snapshot import validate


CONFIG = {
    "id": "hkix.hkg", "sourceUrl": OFFICIAL_BASE,
    "download": {"maxBytes": 1024, "attempts": 1},
    "publish": {"maxSnapshotBytes": 2 * 1024**3, "maxNormalizedBytes": 1024**3,
                "maxDiffBytes": 256 * 1024**2, "maxManagedBytes": 8 * 1024**3,
                "keepSnapshots": 2, "keepDiffs": 2},
}


class FakeError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeR2:
    def __init__(self):
        self.objects = {}
        self.calls = []
        self.conflict = False
        self.corrupt = False

    def get_object(self, *, Bucket, Key):
        self.calls.append(("get", Key))
        if Key not in self.objects:
            raise FakeError("NoSuchKey")
        obj = self.objects[Key]
        return {"Body": io.BytesIO(obj["body"]), "ContentLength": len(obj["body"]), "ETag": obj["etag"]}

    def put_object(self, *, Bucket, Key, Body, ContentLength, ContentMD5, Metadata, **kwargs):
        self.calls.append(("put", Key))
        old = self.objects.get(Key)
        if kwargs.get("IfNoneMatch") == "*" and old:
            raise FakeError("PreconditionFailed")
        if kwargs.get("IfMatch") and (not old or old["etag"] != kwargs["IfMatch"]):
            raise FakeError("PreconditionFailed")
        if Key == "latest.json" and self.conflict:
            raise FakeError("PreconditionFailed")
        raw = Body if isinstance(Body, bytes) else Body.read()
        assert len(raw) == ContentLength
        assert base64.b64encode(hashlib.md5(raw).digest()).decode() == ContentMD5
        self.objects[Key] = {"body": raw, "metadata": Metadata,
                             "etag": '"' + hashlib.md5(raw).hexdigest() + '"'}
        return {"ETag": self.objects[Key]["etag"]}

    def head_object(self, *, Bucket, Key):
        self.calls.append(("head", Key))
        obj = self.objects[Key]
        return {"ContentLength": len(obj["body"]) + int(self.corrupt), "Metadata": obj["metadata"]}

    def delete_object(self, *, Bucket, Key):
        self.calls.append(("delete", Key))
        del self.objects[Key]

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        return self

    def paginate(self, *, Bucket):
        return [{"Contents": [{"Key": key, "Size": len(obj["body"])} for key, obj in self.objects.items()]}]


def fixture(directory, day, previous=None):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "p0").mkdir()
    payloads = {
        "p0/v4.index.bin": struct.pack(">16sIHH", bytes(16), 0, 1, 0),
        "p0/v4.records.bin": bytes(24),
        "p0/v4.paths.bin": b"",
        "normalized.jsonl.gz": gzip.compress(b"", mtime=0),
        "diff.jsonl.gz": gzip.compress(b"", mtime=0),
    }
    files = []
    for key, raw in payloads.items():
        (directory / key).write_bytes(raw)
        files.append({"key": key, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
    manifest = {
        "schemaVersion": 1, "snapshotId": f"200001{day:02}T000000Z",
        "generatedAt": f"2000-01-{day:02}T00:00:00Z", "dataTime": f"2000-01-{day:02}T00:00:00Z",
        "collector": {"id": "synthetic", "location": "Synthetic fixture", "sourceUrl": "https://example.invalid"},
        "defaultPeer": "p0", "peers": [{"id": "p0", "asn": 64512, "address": "192.0.2.1", "label": "Synthetic peer", "families": {
            "4": {"index": "p0/v4.index.bin", "records": "p0/v4.records.bin", "paths": "p0/v4.paths.bin", "intervalCount": 1, "indexCount": 1, "prefixCount": 1000},
        }}],
        "files": files, "normalizedRoutes": "normalized.jsonl.gz", "diff": "diff.jsonl.gz",
        "previousSnapshotId": previous,
    }
    (directory / "manifest.json").write_text(json.dumps(manifest))
    return manifest


class FakeHTTP(io.BytesIO):
    status = 200

    def __init__(self, raw, headers=None):
        super().__init__(raw)
        self.headers = headers or {"Content-Length": str(len(raw)), "Content-Type": "application/x-bzip2"}

    def geturl(self):
        return snapshot_metadata("2000-01-01")["url"]


class FakeOpener:
    def __init__(self, raw, headers=None):
        self.raw, self.headers = raw, headers
        self.calls = 0

    def open(self, request, timeout):
        self.calls += 1
        assert request.full_url == snapshot_metadata("2000-01-01")["url"]
        return FakeHTTP(self.raw, self.headers)


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_download_pins_source_and_uses_atomic_output(self):
        output = self.root / "input.bz2"
        opener = FakeOpener(b"BZh9fixture-only")
        metadata = download("2000-01-01", output, CONFIG, opener)
        self.assertEqual(metadata["bytes"], 16)
        self.assertEqual(output.read_bytes(), b"BZh9fixture-only")
        self.assertFalse(output.with_name("input.bz2.partial").exists())
        self.assertEqual(opener.calls, 1)
        with self.assertRaises(ValueError):
            download("2000-01-01", self.root / "other", {**CONFIG, "sourceUrl": "https://untrusted.invalid"}, opener)
        self.assertEqual(opener.calls, 1)

    def test_download_rejects_html_size_overrun_and_truncation(self):
        cases = [
            (b"<html>", {"Content-Type": "text/html"}),
            (b"BZh9" + b"x" * 1024, {}),
            (b"BZh9short", {"Content-Length": "100"}),
            (b"nope", {}),
        ]
        for raw, headers in cases:
            with self.subTest(raw=raw[:10]):
                target = self.root / "rejected.bz2"
                with self.assertRaises(ValueError):
                    download("2000-01-01", target, CONFIG, FakeOpener(raw, headers))
                self.assertFalse(target.exists())
                self.assertFalse(target.with_name("rejected.bz2.partial").exists())

    def test_validator_rejects_corrupted_bytes_and_path_traversal(self):
        output = self.root / "snapshot"
        fixture(output, 1)
        self.assertEqual(validate(output, CONFIG)["snapshotId"], "20000101T000000Z")
        (output / "p0/v4.records.bin").write_bytes(bytes(23))
        with self.assertRaises(ValueError):
            validate(output, CONFIG)
        manifest = json.loads((output / "manifest.json").read_text())
        manifest["files"][0]["key"] = "../escape"
        (output / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            validate(output, CONFIG)

    def test_publish_pointer_is_last_and_retains_two_versions(self):
        client = FakeR2()
        for day in (1, 2, 3):
            previous_dir = self.root / f"prior{day}"
            previous = fetch_previous(client, "test", previous_dir, CONFIG)
            output = self.root / f"day{day}"
            manifest = fixture(output, day, previous["snapshotId"])
            publish(client, "test", output, previous_dir / "previous.json", CONFIG)
            puts = [key for operation, key in client.calls if operation == "put"]
            self.assertEqual(puts[-1], "latest.json")
            self.assertEqual(json.loads(client.objects["latest.json"]["body"])["snapshotId"], manifest["snapshotId"])
        self.assertFalse(any(key.startswith("snapshots/20000101T") for key in client.objects))
        self.assertTrue(any(key.startswith("snapshots/20000102T") for key in client.objects))
        self.assertTrue(any(key.startswith("snapshots/20000103T") for key in client.objects))
        self.assertEqual(len([key for key in client.objects if key.startswith("diffs/")]), 2)

    def test_corrupt_upload_never_advances_pointer(self):
        client = FakeR2()
        previous_dir = self.root / "previous"
        fetch_previous(client, "test", previous_dir, CONFIG)
        output = self.root / "snapshot"
        fixture(output, 1)
        client.corrupt = True
        with self.assertRaisesRegex(ValueError, "verification"):
            publish(client, "test", output, previous_dir / "previous.json", CONFIG)
        self.assertNotIn("latest.json", client.objects)

    def test_cas_conflict_never_advances_pointer(self):
        client = FakeR2()
        previous_dir = self.root / "previous"
        fetch_previous(client, "test", previous_dir, CONFIG)
        output = self.root / "snapshot"
        fixture(output, 1)
        client.conflict = True
        with self.assertRaisesRegex(ValueError, "Another publisher"):
            publish(client, "test", output, previous_dir / "previous.json", CONFIG)
        self.assertNotIn("latest.json", client.objects)

    def test_stale_diff_and_older_snapshot_are_rejected(self):
        client = FakeR2()
        previous_dir = self.root / "previous"
        fetch_previous(client, "test", previous_dir, CONFIG)
        output = self.root / "snapshot"
        fixture(output, 2)
        publish(client, "test", output, previous_dir / "previous.json", CONFIG)
        with self.assertRaisesRegex(ValueError, "changed after"):
            publish(client, "test", output, previous_dir / "previous.json", CONFIG)
        fresh_previous = self.root / "fresh"
        previous = fetch_previous(client, "test", fresh_previous, CONFIG)
        older = self.root / "older"
        fixture(older, 1, previous["snapshotId"])
        with self.assertRaisesRegex(ValueError, "Previous snapshot must predate"):
            publish(client, "test", older, fresh_previous / "previous.json", CONFIG)

    def test_config_errors_and_coverage_drop_stop_before_upload(self):
        client = FakeR2()
        prior = self.root / "prior"
        fetch_previous(client, "test", prior, CONFIG)
        output = self.root / "day1"
        fixture(output, 1)
        bad = {**CONFIG, "publish": {**CONFIG["publish"], "keepSnapshots": 3}}
        with self.assertRaisesRegex(ValueError, "keepSnapshots"):
            publish(client, "test", output, prior / "previous.json", bad)
        self.assertFalse(any(call[0] == "put" for call in client.calls))
        publish(client, "test", output, prior / "previous.json", CONFIG)
        latest = client.objects["latest.json"]["body"]
        prior2 = self.root / "prior2"
        previous = fetch_previous(client, "test", prior2, CONFIG)
        output2 = self.root / "day2"
        manifest = fixture(output2, 2, previous["snapshotId"])
        manifest["peers"][0]["families"]["4"]["prefixCount"] = 899
        (output2 / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "coverage fell"):
            publish(client, "test", output2, prior2 / "previous.json", CONFIG)
        self.assertEqual(client.objects["latest.json"]["body"], latest)

    def test_retry_reuses_identical_immutable_manifest_after_pointer_failure(self):
        client = FakeR2()
        prior = self.root / "prior"
        fetch_previous(client, "test", prior, CONFIG)
        output = self.root / "day1"
        manifest = fixture(output, 1)
        client.conflict = True
        with self.assertRaisesRegex(ValueError, "Another publisher"):
            publish(client, "test", output, prior / "previous.json", CONFIG)
        immutable = client.objects["snapshots/20000101T000000Z/manifest.json"]["body"]
        manifest["generatedAt"] = "2000-01-01T00:10:00Z"
        (output / "manifest.json").write_text(json.dumps(manifest))
        client.conflict = False
        publish(client, "test", output, prior / "previous.json", CONFIG)
        self.assertEqual(client.objects["latest.json"]["body"], immutable)

    def test_every_record_is_validated_even_if_hash_matches(self):
        output = self.root / "day1"
        manifest = fixture(output, 1)
        path = output / "p0/v4.records.bin"
        raw = bytes(23) + bytes([255])
        path.write_bytes(raw)
        item = next(item for item in manifest["files"] if item["key"] == "p0/v4.records.bin")
        item["sha256"] = hashlib.sha256(raw).hexdigest()
        (output / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "record flags"):
            validate(output, CONFIG)


if __name__ == "__main__":
    unittest.main()
