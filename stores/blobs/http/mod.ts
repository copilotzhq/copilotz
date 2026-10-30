/**
 * Blobs in a bucket over HTTP: `PUT` and `GET` `<url>/<id>`, which object
 * stores serve (S3, GCS, R2, MinIO), directly or through a signing proxy.
 * `headers` adds what a request needs (an Authorization, say), per request.
 * Content-addressed: an id that exists is the same content, so putting it
 * again is harmless.
 */
import type { Blobs } from "../../../runtime/mod.ts";

export function httpBlobs(options: {
  /** The bucket's base URL: blobs are `<url>/<id>`. */
  url: string;
  /** Headers for each request (for a method and a blob id), such as credentials. */
  headers?(method: "GET" | "PUT", id: string): HeadersInit | Promise<HeadersInit>;
  fetch?: typeof fetch;
}): Blobs {
  const go = options.fetch ?? fetch;
  const at = (id: string) => `${options.url.replace(/\/$/, "")}/${encodeURIComponent(id)}`;
  return {
    async put({ id, data, type }) {
      const response = await go(at(id), {
        method: "PUT",
        headers: {
          "content-type": type ?? "application/octet-stream",
          ...await options.headers?.("PUT", id),
        },
        body: data as BodyInit,
      });
      if (!response.ok) throw new Error(`Putting blob ${id}: HTTP ${response.status}`);
      await response.body?.cancel();
    },
    async get(id) {
      const response = await go(at(id), { headers: await options.headers?.("GET", id) });
      if (response.status === 404) return (await response.body?.cancel(), null);
      if (!response.ok) throw new Error(`Getting blob ${id}: HTTP ${response.status}`);
      return {
        data: new Uint8Array(await response.arrayBuffer()),
        ...(response.headers.get("content-type")
          ? { type: response.headers.get("content-type")! }
          : {}),
      };
    },
  };
}
