import "server-only";

// Narrow HTTP client for Google Drive resumable upload (§G).
//
// Layer F uses raw HTTP for the resumable protocol because
// `googleapis` auto-managed uploads swallow the session URI (§G.3).
// This module intentionally does NOT reuse gaxios: we want zero
// framework retries (Layer F owns retries), zero auto-header
// injection (we compose Authorization ourselves), and zero
// response-body caching that could pin an access token in memory.
//
// Absolute rules:
//   * Never log a request URL (session URIs are bearer-equivalent).
//   * Never log a request header (Authorization / Cookie).
//   * Never log a request body (could contain OAuth exchange payloads).
//   * Every request is bounded by an `AbortController` timeout so a
//     hung TLS socket cannot pin a worker indefinitely.

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type HttpRequest = {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: Buffer | string;
  timeoutMs: number;
};

export type HttpResponse = {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: Buffer;
};

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

// Production factory: use the Node global fetch (Node ≥ 18) wrapped
// with an AbortController-based timeout. Never adds retries, never
// mutates a shared state, never installs an interceptor.
export function defaultHttpClient(): HttpClient {
  return async (req) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
    try {
      // Wrap `fetch` at call time: crypto/tests may run under a
      // custom fetch (e.g., a test seam) and we want that to win over
      // a captured reference.
      // Runtime: Node's fetch accepts Buffer as body via its
      // Uint8Array superclass. TS lib.dom types only list a narrower
      // set (Blob, FormData, URLSearchParams, string, ArrayBufferView).
      // A Uint8Array view of the underlying buffer satisfies BodyInit.
      const body =
        req.body === undefined
          ? undefined
          : typeof req.body === "string"
          ? req.body
          : new Uint8Array(
              req.body.buffer,
              req.body.byteOffset,
              req.body.byteLength
            );
      // TS lib.dom's `BodyInit` is a strict browser union that omits
      // `Uint8Array`, even though Node's `fetch` accepts it at runtime.
      // Cast through `unknown` so the source shape is not silently
      // widened while still letting Node take our binary body.
      const resp = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: body as unknown as BodyInit | undefined,
        signal: ctrl.signal
      });
      const buf = Buffer.from(await resp.arrayBuffer());
      const headers: Record<string, string> = {};
      resp.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: resp.status, headers, body: buf };
    } finally {
      clearTimeout(timer);
    }
  };
}
