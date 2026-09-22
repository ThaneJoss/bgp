#!/usr/bin/env python3
"""Download ONE pinned HKIX RIB only when this command is explicitly executed.

Tests must inject a mock opener; importing this module never performs network IO.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

OFFICIAL_BASE = "https://archive.routeviews.org/hkix.hkg/bgpdata/"
ABSOLUTE_BYTE_CAP = 1024 * 1024 * 1024


def snapshot_metadata(date: str | None = None) -> dict:
    day = dt.date.fromisoformat(date) if date else dt.datetime.now(dt.timezone.utc).date()
    if day > dt.datetime.now(dt.timezone.utc).date():
        raise ValueError("Snapshot date cannot be in the future")
    compact = day.strftime("%Y%m%d")
    return {
        "snapshotId": f"{compact}T000000Z",
        "dataTime": f"{day.isoformat()}T00:00:00Z",
        "url": f"{OFFICIAL_BASE}{day:%Y.%m}/RIBS/rib.{compact}.0000.bz2",
    }


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Upstream redirect rejected: only the exact official snapshot URL is allowed")


def download(date: str | None, destination: Path, config: dict, opener=None) -> dict:
    if config.get("id") != "hkix.hkg" or config.get("sourceUrl") != OFFICIAL_BASE:
        raise ValueError("Only the configured official HKIX archive is authorized")
    metadata = snapshot_metadata(date)
    settings = config.get("download", {})
    maximum = min(int(settings.get("maxBytes", ABSOLUTE_BYTE_CAP)), ABSOLUTE_BYTE_CAP)
    timeout = min(max(int(settings.get("timeoutSeconds", 60)), 1), 120)
    attempts = min(max(int(settings.get("attempts", 3)), 1), 3)
    if maximum < 4:
        raise ValueError("Download byte budget is too small")
    opener = opener or urllib.request.build_opener(NoRedirect())
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".partial")
    if destination.exists():
        raise FileExistsError("Destination exists; refusing to replace a prior input")
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(metadata["url"], headers={
                "User-Agent": "route-atlas-offline-builder/1.0",
                "Accept": "application/octet-stream, application/x-bzip2",
                "Accept-Encoding": "identity",
            })
            with opener.open(request, timeout=timeout) as response:
                if response.status != 200 or response.geturl() != metadata["url"]:
                    raise ValueError("Unexpected response or URL; refusing to consume it")
                content_type = response.headers.get("Content-Type", "").lower()
                if "html" in content_type or "json" in content_type or "xml" in content_type:
                    raise ValueError("Upstream returned a document rather than a compressed RIB")
                declared = response.headers.get("Content-Length")
                if declared is not None and (int(declared) > maximum or int(declared) < 4):
                    raise ValueError("Upstream Content-Length violates the download byte budget")
                total = 0
                sha = hashlib.sha256()
                with temporary.open("wb") as stream:
                    magic = response.read(4)
                    if len(magic) != 4 or magic[:3] != b"BZh" or magic[3:4] not in b"123456789":
                        raise ValueError("Input is not a bzip2 stream")
                    stream.write(magic)
                    sha.update(magic)
                    total += len(magic)
                    while True:
                        block = response.read(min(1024 * 1024, maximum - total + 1))
                        if not block:
                            break
                        total += len(block)
                        if total > maximum:
                            raise ValueError("Download exceeded hard byte limit")
                        stream.write(block)
                        sha.update(block)
                    if declared is not None and total != int(declared):
                        raise ValueError("Truncated input: Content-Length mismatch")
                    stream.flush()
                    os.fsync(stream.fileno())
            os.replace(temporary, destination)
            metadata.update(bytes=total, sha256=sha.hexdigest(), file=str(destination))
            return metadata
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            temporary.unlink(missing_ok=True)
            # Missing snapshots and configuration errors are not transient.
            if isinstance(error, urllib.error.HTTPError) and error.code < 500 and error.code != 429:
                raise
            if attempt + 1 == attempts:
                raise
            time.sleep(2 ** attempt)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
    raise RuntimeError("Download did not complete")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("config/bgp-collector.json"))
    parser.add_argument("--date", help="UTC date YYYY-MM-DD; default today, always 00:00 UTC")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--allow-download", action="store_true", help="Explicit opt-in required")
    args = parser.parse_args()
    if not args.allow_download:
        parser.error("No network request made: pass --allow-download to explicitly authorize this download")
    metadata = download(args.date, args.output, json.loads(args.config.read_text()))
    args.metadata.parent.mkdir(parents=True, exist_ok=True)
    args.metadata.write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps({key: metadata[key] for key in ("snapshotId", "dataTime", "bytes")}))


if __name__ == "__main__":
    main()
