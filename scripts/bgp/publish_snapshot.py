#!/usr/bin/env python3
"""Fetch prior diff state or publish a validated BGP snapshot to a dedicated R2 bucket.

The mutable pointer uses a conditional write. No R2 IO happens at import time.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys

from validate_snapshot import MANIFEST_LIMIT, file_hash, load_manifest, safe_key, snapshot_id, validate

REQUIRED_ENV = ("R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")


def check_environment() -> None:
    missing = [key for key in REQUIRED_ENV if not os.environ.get(key)]
    if missing:
        raise ValueError("R2 is not configured. Set repository secrets/variables: " + ", ".join(missing))
    if not re.fullmatch(r"[a-fA-F0-9]{32}", os.environ["R2_ACCOUNT_ID"]):
        raise ValueError("R2_ACCOUNT_ID must be the 32-character Cloudflare account ID")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", os.environ["R2_BUCKET"]):
        raise ValueError("Invalid R2 bucket name")


def make_client():
    check_environment()
    try:
        import boto3
        from botocore.config import Config
    except ImportError as error:
        raise RuntimeError("Install the pinned CI dependency: boto3==1.43.98") from error
    return boto3.client(
        "s3", region_name="auto",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(
            retries={"mode": "standard", "max_attempts": 3},
            s3={"addressing_style": "path"},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )


def error_code(error: Exception) -> str:
    return str(getattr(error, "response", {}).get("Error", {}).get("Code", ""))


def read_latest(client, bucket: str) -> tuple[dict | None, str | None]:
    try:
        response = client.get_object(Bucket=bucket, Key="latest.json")
    except Exception as error:
        if error_code(error) in ("NoSuchKey", "404", "NotFound"):
            return None, None
        raise
    with response["Body"] as stream:
        raw = stream.read(MANIFEST_LIMIT + 1)
    if response.get("ContentLength", len(raw)) > MANIFEST_LIMIT:
        raise ValueError("Remote latest.json exceeds its byte limit")
    return load_manifest(raw), response["ETag"]


def fetch_previous(client, bucket: str, directory: Path, config: dict) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    manifest, etag = read_latest(client, bucket)
    descriptor = {"snapshotId": None, "etag": None, "normalizedFile": None}
    if manifest:
        key = safe_key(manifest["normalizedRoutes"])
        item = next(item for item in manifest["files"] if item["key"] == key)
        maximum = min(int(config["publish"]["maxNormalizedBytes"]), 1024**3)
        if item["bytes"] > maximum:
            raise ValueError("Previous normalized routes exceed the configured read budget")
        target = directory / "normalized.jsonl.gz"
        temporary = target.with_suffix(target.suffix + ".partial")
        response = client.get_object(Bucket=bucket, Key=f"snapshots/{manifest['snapshotId']}/{key}")
        if response["ContentLength"] != item["bytes"]:
            response["Body"].close()
            raise ValueError("Previous normalized object has an unexpected size")
        sha = hashlib.sha256()
        size = 0
        try:
            with response["Body"] as source, temporary.open("wb") as output:
                while True:
                    block = source.read(min(1024 * 1024, maximum - size + 1))
                    if not block:
                        break
                    size += len(block)
                    if size > maximum:
                        raise ValueError("Previous normalized object exceeds its byte limit")
                    sha.update(block)
                    output.write(block)
            if size != item["bytes"] or sha.hexdigest() != item["sha256"]:
                raise ValueError("Previous normalized object failed integrity verification")
            temporary.replace(target)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        descriptor.update(snapshotId=manifest["snapshotId"], etag=etag, normalizedFile=str(target.resolve()))
    (directory / "previous.json").write_text(json.dumps(descriptor, indent=2) + "\n")
    return descriptor


def all_objects(client, bucket: str) -> list[dict]:
    # The configured bucket must be dedicated to this dataset. The total-budget
    # check also counts unrelated objects, while deletion is strictly namespaced.
    result = []
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket):
        result.extend(page.get("Contents", []))
        if len(result) > 10000:
            raise ValueError("Bucket exceeds the 10,000-object safety limit; use a dedicated bucket")
    return result


def put_immutable(client, bucket: str, key: str, path: Path, content_type: str) -> None:
    digest = file_hash(path)
    length = path.stat().st_size
    md5 = base64.b64encode(bytes.fromhex(file_hash(path, "md5"))).decode("ascii")
    try:
        with path.open("rb") as stream:
            client.put_object(
                Bucket=bucket, Key=key, Body=stream, ContentLength=length,
                ContentType=content_type, ContentMD5=md5,
                Metadata={"sha256": digest}, IfNoneMatch="*",
                CacheControl="public, max-age=31536000, immutable",
            )
    except Exception as error:
        if error_code(error) not in ("PreconditionFailed", "412", "ConditionalRequestConflict", "409"):
            raise
        # A retry may find the same already-uploaded immutable bytes. A different
        # object under this snapshot ID is a hard error; never overwrite it.
    head = client.head_object(Bucket=bucket, Key=key)
    if head["ContentLength"] != length or head.get("Metadata", {}).get("sha256") != digest:
        raise ValueError(f"Immutable object differs or failed upload verification: {key}")


def publish(client, bucket: str, directory: Path, previous_path: Path, config: dict) -> dict:
    settings = config.get("publish", {})
    if settings.get("keepSnapshots", 2) != 2:
        raise ValueError("This publisher currently requires keepSnapshots=2")
    keep_diffs = settings.get("keepDiffs", 7)
    if type(keep_diffs) is not int or not 1 <= keep_diffs <= 30:
        raise ValueError("keepDiffs must be an integer between 1 and 30")
    ratio = settings.get("minPreviousPrefixRatio", 0.9)
    if type(ratio) not in (int, float) or not 0 < ratio <= 1:
        raise ValueError("minPreviousPrefixRatio must be greater than zero and at most one")
    maximum = settings.get("maxManagedBytes", 8 * 1024**3)
    if type(maximum) is not int or not 1 <= maximum <= 8 * 1024**3:
        raise ValueError("maxManagedBytes must be a positive integer no greater than 8 GiB")
    manifest = validate(directory, config)
    identifier = manifest["snapshotId"]
    previous = json.loads(previous_path.read_text())
    base_id = previous.get("snapshotId")
    if base_id is not None:
        snapshot_id(base_id)
    if manifest.get("previousSnapshotId") != base_id:
        raise ValueError("Diff base and fetched previous snapshot differ; rebuild from the current base")
    current, current_etag = read_latest(client, bucket)
    if current_etag != previous.get("etag") or (current or {}).get("snapshotId") != base_id:
        raise ValueError("The current snapshot changed after diff generation; refusing to publish stale output")
    if base_id is not None and identifier <= base_id:
        raise ValueError("Refusing to replace the current snapshot with an older or equal snapshot")
    if current:
        if current["collector"]["id"] != manifest["collector"]["id"]:
            raise ValueError("Collector changes require an explicit migration rather than a daily diff")
        new_peers = {(peer["asn"], peer["address"]): peer for peer in manifest["peers"]}
        for old_peer in current["peers"]:
            peer = new_peers.get((old_peer["asn"], old_peer["address"]))
            if peer is None:
                raise ValueError("A previously published peer session disappeared; publication stopped")
            for family, old_family in old_peer["families"].items():
                new_family = peer["families"].get(family)
                if new_family is None or new_family["prefixCount"] < old_family["prefixCount"] * ratio:
                    raise ValueError("Prefix coverage fell below minPreviousPrefixRatio; publication stopped")
    objects = all_objects(client, bucket)
    existing = {item["Key"]: item["Size"] for item in objects}
    prefix = f"snapshots/{identifier}/"
    # A previous attempt may have finished immutable uploads and then failed at
    # the pointer switch. Reuse its manifest only when every semantic field and
    # every object digest match; volatile build timings are not data identity.
    manifest_key = prefix + "manifest.json"
    if manifest_key in existing:
        response = client.get_object(Bucket=bucket, Key=manifest_key)
        with response["Body"] as stream:
            stored_raw = stream.read(MANIFEST_LIMIT + 1)
        stored = load_manifest(stored_raw)
        def stable(value):
            value = json.loads(json.dumps(value))
            value.pop("generatedAt", None)
            value.get("statistics", {}).pop("buildSeconds", None)
            return value
        if stable(stored) != stable(manifest):
            raise ValueError("Existing immutable snapshot differs semantically; refusing to overwrite it")
        (directory / "manifest.json").write_bytes(stored_raw)
        if (directory / "latest.json").exists():
            (directory / "latest.json").write_bytes(stored_raw)
        manifest = stored
    files = [(prefix + item["key"], directory / item["key"]) for item in manifest["files"]]
    files.append((prefix + "manifest.json", directory / "manifest.json"))
    files.append((f"diffs/{identifier}.jsonl.gz", directory / manifest["diff"]))
    growth = sum(path.stat().st_size for key, path in files if key not in existing)
    if sum(existing.values()) + growth + MANIFEST_LIMIT > maximum:
        raise ValueError("Publishing would exceed the 8 GiB/configured bucket budget, including temporary versions")
    for key, path in files:
        kind = "application/json" if key.endswith(".json") else "application/octet-stream"
        put_immutable(client, bucket, key, path, kind)
    raw = (directory / "manifest.json").read_bytes()
    condition = {"IfMatch": current_etag} if current_etag else {"IfNoneMatch": "*"}
    try:
        client.put_object(
            Bucket=bucket, Key="latest.json", Body=raw, ContentLength=len(raw),
            ContentType="application/json", CacheControl="public, max-age=60",
            ContentMD5=base64.b64encode(hashlib.md5(raw).digest()).decode("ascii"),
            Metadata={"sha256": hashlib.sha256(raw).hexdigest()}, **condition,
        )
    except Exception as error:
        if error_code(error) in ("PreconditionFailed", "412", "ConditionalRequestConflict", "409"):
            raise ValueError("Another publisher changed latest.json; immutable files remain safe, pointer unchanged by this job") from error
        raise
    committed, _ = read_latest(client, bucket)
    if not committed or committed["snapshotId"] != identifier:
        raise ValueError("Published pointer changed before verification; retention cleanup skipped")
    # The previous version remains available for in-flight requests, and for
    # tomorrow's diff. Never delete a snapshot newer than the base we observed.
    diff_keys = sorted(item["Key"] for item in objects
                       if re.fullmatch(r"diffs/\d{8}T\d{6}Z\.jsonl\.gz", item["Key"]))
    diff_keys = sorted(set(diff_keys + [f"diffs/{identifier}.jsonl.gz"]))
    delete_diffs = set(diff_keys[:-keep_diffs])
    deleted = 0
    for item in objects:
        key = item["Key"]
        match = re.fullmatch(r"snapshots/(\d{8}T\d{6}Z)/.+", key)
        obsolete = bool(match and base_id and match.group(1) < base_id)
        if obsolete or key in delete_diffs:
            client.delete_object(Bucket=bucket, Key=key)
            deleted += 1
    return {"snapshotId": identifier, "objects": len(files), "bytes": sum(path.stat().st_size for _, path in files), "deletedObjects": deleted}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check-env", "fetch-previous", "publish"))
    parser.add_argument("--config", type=Path, default=Path("config/bgp-collector.json"))
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--previous-descriptor", type=Path)
    parser.add_argument("--allow-write", action="store_true")
    args = parser.parse_args()
    if args.command == "check-env":
        check_environment()
        print("Required R2 environment is configured; no network request made")
        return
    if not args.directory:
        parser.error("--directory is required")
    if args.command == "publish" and (not args.allow_write or not args.previous_descriptor):
        parser.error("Publishing requires --allow-write and --previous-descriptor")
    client = make_client()
    config = json.loads(args.config.read_text())
    if args.command == "fetch-previous":
        result = fetch_previous(client, os.environ["R2_BUCKET"], args.directory, config)
    else:
        result = publish(client, os.environ["R2_BUCKET"], args.directory, args.previous_descriptor, config)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError) as error:
        print(f"BGP publication stopped: {error}", file=sys.stderr)
        sys.exit(1)
