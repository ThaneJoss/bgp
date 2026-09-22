# Daily offline build and publication

The implementation is configured for one RouteViews collector: **hkix.hkg at
HKIX, Hong Kong**. It is in Asia and is not a mainland-China collector.
`config/bgp-collector.json` strictly selects these AS3491 (PCCW / Console Connect)
sessions; it does not silently replace them with another operator:

| Session | Peer address | Minimum prefixes to publish that family |
|---|---|---:|
| IPv4 | `123.255.90.244` | 800,000 |
| IPv6 | `2001:7fa:0:1::ca28:a0f4` | 150,000 |

These are two separate BGP sessions. Queries compare two destinations from one
selected session. A session without the requested address family returns
`missing_family`; the service must not pretend the two sessions form a single
observed path. These thresholds check dataset coverage and are not a promise
that every globally existing prefix or path is observable.

Before publication, each existing session/family must also retain at least
**90% of its previous published prefix count**. A missing session/family or a
larger decrease stops the update and keeps the previous pointer. This is a
configurable anomaly guard, not proof that the routing data is complete.

## Execution location and triggers

`bgp-daily.yml` runs on a GitHub-hosted Ubuntu runner. That runner downloads
the RouteViews RIB, parses MRT, builds indices and diffs, validates the output,
and uploads the generated files through the authenticated `/_ingest` endpoint of the `bgp` Worker
to the Cloudflare R2 bucket `route-atlas-bgp`. R2 stores the published library.
One Cloudflare Worker, `bgp`, hosts the frontend, query handler and publication
endpoint. Queries only read that library. The publication handler transfers
generated objects through its native `BGP_BUCKET` binding; it does not download or parse the upstream RIB.
Neither frontend builds nor query requests download the upstream RIB.
Frontend npm/pnpm installation downloads JavaScript dependencies, not BGP data.

* `bgp-checks.yml` runs only local synthetic Python/JavaScript correctness tests
  and the synthetic query benchmark. It does not need cloud credentials.
* `BGP daily snapshot` runs daily at 03:17 UTC and can also be run manually
  with an optional snapshot date. There is no separate enable variable or
  confirmation checkbox.
* The workflow passes the downloader's `--allow-download` and publisher's
  `--allow-write` flags. Importing either module performs no IO.
* CAIDA topology assets are committed static snapshots. This daily workflow
  updates the RouteViews path library only; CAIDA has no scheduled workflow.

Worker deployment and real Cloudflare CPU measurements are separate steps.

## Required GitHub configuration

The dedicated **R2 Standard** bucket is `route-atlas-bgp`. The `bgp`
Worker binds it as `BGP_BUCKET`. The query handler only reads data; the
`/_ingest` publication endpoint requires a bearer secret for all read, list, put, compose and delete operations.

Configure the following in the GitHub repository:

| Kind | Name | Value |
|---|---|---|
| Variable | `R2_BUCKET` | `route-atlas-bgp` |
| Variable | `R2_PUBLISH_URL` | `https://bgp.thanejoss.com/_ingest` |
| Secret | `R2_PUBLISH_TOKEN` | Same value as the `bgp` Worker's `INGEST_TOKEN` secret |

Set the Worker secret with `wrangler secret put INGEST_TOKEN --config
wrangler.jsonc`. Keep its value in secrets storage only.
GitHub needs neither R2 S3 credentials nor a Cloudflare account-wide API token.
The publication handler uses the R2 binding; `R2_ACCOUNT_ID` is not required.
A local Wrangler login does not configure the GitHub Variables or Secrets.
Once configured, run `BGP daily snapshot` from GitHub Actions for the first
publication; subsequent scheduled runs use the same settings.

No secret is printed. Missing configuration stops the workflow **before the
upstream RIB download**. The workflow does not create a bucket or enable billing.
R2 is usage-based billing with a free allowance, not an automatic zero-cost cap.
Other applications or query traffic in this account can consume that allowance.

The standard public-repository GitHub-hosted Linux runner is the intended free
compute option. Private repositories consume the account's included runner
minutes and can become billable after the allowance. Scheduled GitHub Actions
can start late and inactive public repositories can have schedules disabled;
this pipeline is a daily snapshot service, not a real-time feed.

## Input and build boundaries

The schedule is **03:17 UTC** daily. It pins that day's **00:00 UTC** RIB:

```text
https://archive.routeviews.org/hkix.hkg/bgpdata/YYYY.MM/RIBS/rib.YYYYMMDD.0000.bz2
```

A manual run can select a date. Future dates and dates older than the currently
published snapshot are rejected. An already-published date skips the input
download. A missing upstream snapshot fails the job; it never silently falls
back to another collector or older file.

The downloader allows only this collector and exact official HTTPS URL pattern,
rejects redirects and HTML/JSON/XML documents, requires bzip2 magic, caps the
compressed input at **1 GiB**, caps retries at three, checks Content-Length when
present, computes SHA-256, and renames a temporary file only after completion.
Decompression and MRT structural validation happen in the builder. It does not
request per-query data from someone else's JSON backend.

The builder scans the MRT file and retains only the two configured sessions. It
generates compact indexed query files, `normalized.jsonl.gz` for the next diff,
and `diff.jsonl.gz`. The first snapshot's diff describes the initial routes;
subsequent diffs compare with the **last successfully published** snapshot. If
one day's job fails, the next diff spans the gap; it must not be labeled an
exact one-day change interval.

The job has a **60-minute timeout**. Raw input, normalized prior state and SQLite
build scratch live only in `_bgp/`; the cleanup step removes them. They are not
committed, cached, or uploaded as GitHub Actions artifacts. The publisher HTTP
client, parser and validator use Python's standard library. Offline Node tests
require no npm installation; `site-checks.yml` installs the locked dependencies
and tests the publication handler against Miniflare's local R2 implementation.

## Publication and retention

Publication occurs in this order:

1. Retrieve `latest.json` and its ETag, then download and verify only the prior
   normalized state needed for the diff.
2. Build and locally verify every listed file's size and SHA-256, the manifest
   bound, every interval record and path value, index page layout, prefix coverage
   and configured storage budgets.
3. Ensure the remote pointer still matches the state used for the diff. Upload
   `snapshots/<timestamp>/...` using `If-None-Match: *`; an existing different
   object is never overwritten. Every upload has a server-checked Content-MD5,
   SHA-256 metadata, and a subsequent HEAD size/metadata verification. Files
   larger than 64 MiB are uploaded in 64 MiB temporary `_uploads/` parts, then
   streamed into one conditional R2 object by the publication handler. The client
   removes temporary parts after the operation; query-file layout is unchanged.
   The bucket lifecycle rule expires `_uploads/` objects after one day to clean
   up parts left by forcibly interrupted runs; published snapshots are excluded.
4. Upload the immutable manifest and a copy of the diff under `diffs/<timestamp>`.
5. Update `latest.json` **last**, with `If-Match: <old ETag>` (or
   `If-None-Match: *` on the first run). A concurrent update fails this publish
   instead of pointing at mixed versions.
6. Confirm the current pointer, then retain the current and previous full
   snapshots and the newest seven diff files. Deletion is limited to this
   pipeline's old `snapshots/` and `diffs/` keys.

GitHub's concurrency group also serializes scheduled and manual ingestion runs.
An upload failure or validation failure leaves the old pointer intact. Partial
immutable uploads can remain after a failed job; a matching retry can reuse them.
If a prior attempt already uploaded its immutable manifest but failed to switch
the pointer, a retry compares every semantic field and file digest. Only
`generatedAt` and `statistics.buildSeconds` may differ; when everything else
matches, the original manifest bytes and original build timestamp are reused.
Old partial snapshots are cleaned when a later publication advances beyond them.
An unexpected hash mismatch on a retry is a deliberate hard failure; inspect it
instead of overwriting a supposedly immutable version.

Default limits in the collector config:

| Limit | Bound |
|---|---:|
| One compressed upstream input | 1 GiB |
| One complete output snapshot | 2 GiB |
| Normalized state object | 1 GiB |
| One compressed diff | 256 MiB |
| Bucket including temporary publication overlap | 8 GiB |
| Full snapshots retained | 2 |
| Diff files retained | 7 |
| Per-session/family prefixes retained versus previous snapshot | At least 90% |
| Manifest read by the Worker | 64 KiB |
| Index read per family | 256 KiB |

The bucket budget counts existing objects, pending upload growth and the largest
file temporarily duplicated during part composition **before** uploads; it fails closed if there is insufficient room. It is a storage guard,
not a guarantee that account-wide R2 charges cannot occur. Changing thresholds
or retention is a conscious configuration change, not an automatic recovery.

There are only a small number of packed files per snapshot, rather than one R2
object per route. The publication handler maps conditional headers, checksums
and metadata to the [native R2 binding API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

## Local verification without downloads

Run from the repository root:

```sh
python -m unittest discover -s tests/bgp -p 'test_build.py' -v
python -m unittest discover -s scripts/bgp -p 'test_pipeline.py' -v
python -m unittest discover -s scripts/bgp -p 'test_r2_http_client.py' -v
node --test tests/bgp/query.test.mjs scripts/bgp/check-worker-cpu.test.mjs scripts/bgp/test-e2e.mjs
node scripts/bgp/bench-query.mjs
```

The publisher pipeline tests use an in-memory R2 adapter, the HTTP client tests
use a local HTTP server, and the downloader tests use a mock HTTP response. They verify rejected inputs, integrity failures, concurrent
publication, stale/older snapshots and retention without external requests.
Local benchmark timing is not Cloudflare's billable CPU measurement; the Worker
CPU acceptance process is documented separately.

After installing locked dependencies, `pnpm run bgp:publisher:test` also checks
authentication, native R2 conditional writes and streamed object composition.
