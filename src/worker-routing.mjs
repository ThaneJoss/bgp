/** Dispatch every service inside the same Worker and share its R2 binding. */
export function createWorker({ website, query, publisher }) {
  return {
    fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/bgp/')) {
        return query.fetch(request, env, ctx);
      }
      if (url.pathname.startsWith('/_ingest/')) {
        url.pathname = url.pathname.slice('/_ingest'.length);
        // Rebuild only the URL; Request construction transfers the streaming
        // body and preserves method, headers, signal, and publisher auth.
        return publisher.fetch(new Request(url, request), env, ctx);
      }
      return website.fetch(request, env, ctx);
    },
  };
}
