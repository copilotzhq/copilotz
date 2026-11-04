/**
 * Blobs in a Google Cloud Storage bucket, through its JSON API: each blob is
 * the object `<prefix>/<id>`, kept with its content type. Written once
 * (`ifGenerationMatch=0`): an id is its content's hash, so an object that's
 * there already is the same content, and GCS refusing to replace it (412)
 * is a success.
 *
 * It signs in as the service account of the instance it runs on (Cloud Run,
 * Compute Engine: the metadata server), keeping each token until a minute
 * before it expires, one request for a new one at a time. `token()` replaces
 * that (locally: `googleToken()` from `copilotz/plugins/compute` reads
 * Application Default Credentials). Each try may take `timeout` ms; a request the
 * network, a timeout, 429 or a 5xx breaks is tried twice more, waiting a
 * little longer each time. Other 4xx fail at once. Web standards only.
 */
import type { Blobs } from "../../../runtime/mod.ts";

/** GCS's JSON API. */
const API = "https://storage.googleapis.com";
/** The token of the instance's service account, on Cloud Run and Compute Engine. */
const METADATA =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
/** A token is renewed this long before it expires. */
const MARGIN = 60_000;
/** Tries per request: the first, and two more. */
const TRIES = 3;
/** How long each try may take, by default. */
const TIMEOUT = 30_000;

type Failure = Error & { status?: number };

const failed = (message: string, status?: number): Failure =>
  Object.assign(new Error(message), status === undefined ? {} : { status });

/** What it says when GCS answers no: the status, and the start of GCS's reason. */
async function failure(response: Response, what: string): Promise<Failure> {
  const text = (await response.text().catch(() => "")).slice(0, 300);
  return failed(`GCS, ${what}: HTTP ${response.status}${text ? ` ${text}` : ""}`, response.status);
}

/** Worth trying again: the network, a timeout, GCS busy (429) or failing (5xx). */
function transient(error: unknown): boolean {
  const { status, name } = error as Failure;
  if (status !== undefined) return status === 429 || status >= 500;
  return error instanceof TypeError || name === "TimeoutError" || name === "AbortError";
}

/** Waits before try `n + 1`: about 200 ms, then 400 ms, give or take a fifth. */
const pause = (n: number) =>
  new Promise((resolve) => setTimeout(resolve, 200 * 2 ** (n - 1) * (0.8 + Math.random() * 0.4)));

/** The metadata server's token, kept until a minute before it expires. */
function metadataToken(go: typeof fetch, timeout: number): () => Promise<string> {
  let kept: { token: string; until: number } | undefined;
  let pending: Promise<{ token: string; until: number }> | undefined;
  const fresh = async () => {
    const response = await go(METADATA, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw await failure(response, "the metadata server's token");
    const body = await response.json() as { access_token: string; expires_in: number };
    return { token: body.access_token, until: Date.now() + body.expires_in * 1000 };
  };
  return async () => {
    if (kept && kept.until - MARGIN > Date.now()) return kept.token;
    pending ??= fresh().finally(() => pending = undefined);
    kept = await pending;
    return kept.token;
  };
}

export function gcsBlobs(options: {
  /** The bucket's name. */
  bucket: string;
  /** A folder for the blobs: objects are `<prefix>/<id>` (default: the bucket's top). */
  prefix?: string;
  /** An access token, asked for each request; default: the metadata server's, kept. */
  token?(): string | Promise<string>;
  /** How long each try may take, in ms (default 30 s). */
  timeout?: number;
  fetch?: typeof fetch;
}): Blobs {
  const go = options.fetch ?? fetch;
  const timeout = options.timeout ?? TIMEOUT;
  const token = options.token ?? metadataToken(go, timeout);
  const bucket = encodeURIComponent(options.bucket);
  const prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
  const name = (id: string) => prefix ? `${prefix}/${id}` : id;

  /** A request, tried again while it breaks in passing; `read` takes its answer. */
  const request = async <T>(
    url: string,
    init: RequestInit,
    read: (response: Response) => Promise<T>,
  ): Promise<T> => {
    for (let n = 1;; n++) {
      try {
        const response = await go(url, {
          ...init,
          headers: {
            ...init.headers as Record<string, string>,
            authorization: `Bearer ${await token()}`,
          },
          signal: AbortSignal.timeout(timeout),
        });
        return await read(response);
      } catch (error) {
        if (n >= TRIES || !transient(error)) throw error;
        await pause(n);
      }
    }
  };

  return {
    put({ id, data, type }) {
      const query = new URLSearchParams({
        uploadType: "media",
        name: name(id),
        ifGenerationMatch: "0",
      });
      return request(
        `${API}/upload/storage/v1/b/${bucket}/o?${query}`,
        {
          method: "POST",
          headers: { "content-type": type ?? "application/octet-stream" },
          body: data as BodyInit,
        },
        async (response) => {
          // 412: the object is there, so this content is.
          if (response.ok || response.status === 412) return void await response.body?.cancel();
          throw await failure(response, `putting blob ${id}`);
        },
      );
    },
    get(id) {
      return request(
        `${API}/storage/v1/b/${bucket}/o/${encodeURIComponent(name(id))}?alt=media`,
        {},
        async (response) => {
          if (response.status === 404) return (await response.body?.cancel(), null);
          if (!response.ok) throw await failure(response, `getting blob ${id}`);
          const type = response.headers.get("content-type");
          return { data: new Uint8Array(await response.arrayBuffer()), ...(type ? { type } : {}) };
        },
      );
    },
  };
}
