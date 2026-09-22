# BGP query handler

This module handles `/api/bgp/*` inside the unified `bgp` Worker. The shared
entrypoint dispatches queries directly to this handler before webpage handling.
Queries only read the `BGP_BUCKET` R2 binding; they never call RIS, RouteViews or
another JSON backend.
No deployment, bucket creation or data download occurs when running its tests.

## API

- `GET /api/bgp/manifest`: snapshot, collector and available peer sessions.
- `GET /api/bgp/path?ip=1.1.1.1&peer=p0`: one observed route.
- `GET /api/bgp/compare?a=1.1.1.1&b=8.8.8.8&peer=p0`: two routes from
  exactly one manifest and one peer session.

Peer IDs come from the manifest, not these examples. A missing address family
returns `missing_family`; an observed non-linear AS_PATH returns
`unsupported_path`; no observed route returns `not_observed`. None means the
destination is unreachable. Results describe collector-peer observations, not
the actual forwarding path between the two user IPs.

Malformed inputs return 400, an unknown peer returns 404, and missing or
structurally invalid snapshot data returns 503. Responses never substitute an
upstream query or a guessed AS path. API responses use `Cache-Control: no-store`
so each request reads the currently published `latest.json` once. The two
comparisons cannot accidentally mix different daily snapshots.

## Bounded query work

See [`../../docs/bgp/format.md`](../../docs/bgp/format.md) for the binary format.
The handler validates and binary-searches compact `DataView` buffers, then reads
one record page and one path per address. It does not parse MRT or load the
complete record/path database.

| Two-address request | Maximum |
| --- | ---: |
| Manifest | 64 KiB |
| Index per address family | 256 KiB |
| Record page per address | 24 KiB |
| AS path per address | 1 KiB / 256 ASNs |
| R2 reads, same family | 6 |
| R2 reads, different families | 7 |
| Total response-body bytes read from R2, different families | 641,024 |

One request shares its index promise when both IPs use the same family. There
is no unbounded global object cache. Each Range body is streamed with an
explicit byte cap, including when an upstream accidentally ignores the range.
Indices and pages receive structural validation; the offline publication job
must validate file SHA-256 hashes before publishing `latest.json`.

This is **bounded lookup, not literal O(1)**: index/page search is logarithmic,
and structural validation is linear in their capped sizes. Local Node timings
cannot prove compliance with Cloudflare's 10 ms Free CPU limit. Inspect actual
deployed invocation `cpuTime` and errors before claiming that limit is met.

## Configuration and local verification

The repository-root [`wrangler.jsonc`](../../wrangler.jsonc) declares
`BGP_BUCKET` and the permitted frontend `APP_ORIGIN`. It deploys the unified
`bgp` Worker, including this handler, the webpage and authenticated uploads.
The frontend uses same-origin `/api/bgp/*`; no separate query Worker or API
Route is needed. CORS never uses `*`. CORS is a browser policy, not
authentication or protection against non-browser callers.

The config deliberately has no Paid-plan `limits.cpu_ms` override. Invocation
logs are enabled for a later real Cloudflare CPU check. Creating an R2 bucket
or deploying this configuration is a separate explicit operation; this repo
does not activate billing subscriptions.

From the repository root:

```sh
node --test tests/bgp/query.test.mjs
node scripts/bgp/bench-query.mjs
```

The unit tests use small synthetic IPv4/IPv6 intervals. The benchmark also uses
synthetic data and makes no network requests. Neither downloads BGP snapshots.
