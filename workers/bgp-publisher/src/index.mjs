import { timingSafeEqual } from "node:crypto";

function authorized(request, token) {
  if (!token) return false;
  const actual = new TextEncoder().encode(request.headers.get("Authorization") || "");
  const expected = new TextEncoder().encode(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function validKey(key) {
  return key === "latest.json" || /^(?:snapshots|diffs)\/[A-Za-z0-9_.\/-]+$/.test(key) && !key.split("/").includes("..") || /^_uploads\/[A-Za-z0-9_-]+\/[0-9]+$/.test(key);
}
function headersFor(object) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
  if (object.customMetadata?.sha256) headers.set("x-amz-meta-sha256", object.customMetadata.sha256);
  return headers;
}
function uploadHeaders(object) {
  const headers = headersFor(object);
  headers.delete("Content-Length");
  return headers;
}
function optionsFor(request) {
  const options = { onlyIf: request.headers, httpMetadata: request.headers,
    customMetadata: {} };
  const digest = request.headers.get("x-amz-meta-sha256");
  if (digest) options.customMetadata.sha256 = digest;
  const md5 = request.headers.get("Content-MD5");
  if (md5) {
    const bytes = Uint8Array.from(atob(md5), char => char.charCodeAt(0));
    if (bytes.byteLength !== 16) throw new Error("Invalid Content-MD5");
    options.md5 = bytes;
  }
  return options;
}
async function compose(request, bucket, key) {
  const { parts, size } = await request.json();
  if (!Number.isSafeInteger(size) || size < 0 || !Array.isArray(parts) || !parts.length || parts.length > 1024) {
    return new Response("Invalid composition", { status: 400 });
  }
  let uploadId;
  let total = 0;
  for (const part of parts) {
    const match = typeof part === "string" && /^_uploads\/([A-Za-z0-9_-]+)\/([0-9]+)$/.exec(part);
    if (!match || (uploadId && uploadId !== match[1])) return new Response("Invalid part", { status: 400 });
    uploadId = match[1];
    const object = await bucket.head(part);
    if (!object) return new Response("Part not found", { status: 404 });
    total += object.size;
  }
  if (new Set(parts).size !== parts.length || total !== size) return new Response("Part size mismatch", { status: 400 });
  const options = optionsFor(request);
  const stream = new FixedLengthStream(size);
  const writer = stream.writable.getWriter();
  const pump = (async () => {
    try {
      for (const part of parts) {
        const object = await bucket.get(part);
        if (!object) throw new Error("Part disappeared");
        const reader = object.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => {});
      throw error;
    }
  })();
  // Observe pump failures immediately, including when R2 rejects without reading.
  pump.catch(() => {});
  try {
    const result = await bucket.put(key, stream.readable, options);
    if (!result) {
      await writer.abort(new Error("Precondition failed")).catch(() => {});
      await pump.catch(() => {});
      return new Response("Precondition failed", { status: 412 });
    }
    await pump;
    return new Response(null, { status: 200, headers: uploadHeaders(result) });
  } catch (error) {
    await writer.abort(error).catch(() => {});
    await pump.catch(() => {});
    throw error;
  }
}
export default {
  async fetch(request, env) {
    if (!authorized(request, env.INGEST_TOKEN)) return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url);
    const bucket = env.BGP_BUCKET;
    if (url.pathname === "/objects" && request.method === "GET") {
      const page = await bucket.list({ limit: 1000, cursor: url.searchParams.get("cursor") || undefined });
      return Response.json({ Contents: page.objects.map(object => ({ Key: object.key, Size: object.size })),
        NextCursor: page.truncated ? page.cursor : null });
    }
    const match = /^\/(objects|compose)\/(.+)$/.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });
    let key;
    try { key = decodeURIComponent(match[2]); } catch { return new Response("Invalid key", { status: 400 }); }
    if (!validKey(key)) return new Response("Invalid key", { status: 400 });
    try {
      if (match[1] === "compose") {
        if (request.method !== "POST" || key.startsWith("_uploads/")) return new Response("Method not allowed", { status: 405 });
        return await compose(request, bucket, key);
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const object = await bucket[request.method === "HEAD" ? "head" : "get"](key);
        if (!object) return new Response("Not found", { status: 404 });
        return new Response(request.method === "HEAD" ? null : object.body, { headers: headersFor(object) });
      }
      if (request.method === "PUT") {
        const object = await bucket.put(key, request.body, optionsFor(request));
        return object ? new Response(null, { headers: uploadHeaders(object) }) : new Response("Precondition failed", { status: 412 });
      }
      if (request.method === "DELETE") {
        await bucket.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response("Method not allowed", { status: 405 });
    } catch (error) {
      const message = String(error?.message || error);
      // R2 may throw a conditional-write error instead of returning null.
      const conditional = /(?:\b10031\b|\bPreconditionFailed\b|precondition(?:s)? failed|conditional request failed)/i.test(message);
      const status = conditional ? 412 : /checksum|digest|Content-MD5|JSON/i.test(message) ? 400 : 500;
      if (status === 500) console.error("R2 publication operation failed:", message);
      return new Response(status === 412 ? "Precondition failed" : status === 400 ? "Invalid upload" : "Storage operation failed", { status });
    }
  },
};
