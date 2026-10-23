import type { WorkHandle } from "../../dependencies/oxian-work.ts";
import type { CopilotzShard, ShardWorkInput } from "./shard.ts";

export const SHARD_WORK_PATH = "/_copilotz/shard/work";
const encoder = new TextEncoder();
const LIMIT = 16 * 1024 * 1024;
function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(text);
}
const unbase64 = (text: string) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const line = (value: unknown) => encoder.encode(JSON.stringify(value) + "\n");
async function boundedBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > LIMIT) throw new TypeError("Shard request too large.");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export class ShardDispatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly started?: boolean,
  ) {
    super(message);
  }
}
/** Host-authenticated controller ingress; authorization also restricts target scope. */
export function createShardControllerHandler(options: {
  shard: Pick<CopilotzShard, "dispatch">;
  /** Authenticate using headers only; the body is never exposed before this succeeds. */
  authenticate(request: Request): boolean | Promise<boolean>;
  authorize(
    request: Request,
    input: ShardWorkInput,
  ): boolean | Promise<boolean>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    if (new URL(request.url).pathname !== SHARD_WORK_PATH) {
      return new Response(null, { status: 404 });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    // Pass a bodyless request so authentication cannot accidentally buffer ingress.
    if (
      !await options.authenticate(
        new Request(request.url, {
          method: request.method,
          headers: request.headers,
          signal: request.signal,
        }),
      )
    ) {
      void request.body?.cancel().catch(() => undefined);
      return Response.json({ error: "forbidden", started: false }, {
        status: 403,
      });
    }
    let handle: WorkHandle | undefined;
    try {
      const body = JSON.parse(
        new TextDecoder().decode(await boundedBody(request.body)),
      );
      if (
        !body || typeof body.workload !== "string" || !body.workload ||
        typeof body.body !== "string" ||
        (body.target !== undefined &&
          (typeof body.target?.workerId !== "string" ||
            !body.target.workerId)) ||
        (body.deadlineAtMs !== undefined && !Number.isFinite(body.deadlineAtMs))
      ) {
        return Response.json({ error: "invalid_request", started: false }, {
          status: 400,
        });
      }
      const input: ShardWorkInput = {
        workload: body.workload,
        target: body.target,
        metadata: body.metadata,
        body: unbase64(body.body),
        deadlineAtMs: body.deadlineAtMs,
        kind: body.kind,
        epoch: body.epoch,
        attemptId: body.attemptId,
        actor: body.actor,
        requireConnected: body.requireConnected,
        signal: request.signal,
      };
      if (!await options.authorize(request, input)) {
        return Response.json({ error: "forbidden", started: false }, {
          status: 403,
        });
      }
      handle = await options.shard.dispatch(input);
      await handle.started;
    } catch (error) {
      // Once a handle exists, only Oxian's terminal classification proves no-start.
      // A lost start acknowledgement may follow side effects on the worker.
      const terminal = handle && await handle.completed.catch(() => undefined);
      const ambiguous = handle &&
        (!terminal || terminal.status === "indeterminate" ||
          terminal.status === "committed");
      void handle?.cancel("controller_failed").catch(() => undefined);
      return Response.json({
        error: (error as { code?: string }).code ?? "dispatch_failed",
        ...(ambiguous ? {} : { started: false }),
      }, { status: 503 });
    }
    const work = handle;
    const iterator = (async function* () {
      try {
        yield line({ type: "metadata", value: await work.metadata });
        for await (const chunk of work.output) {
          for (let i = 0; i < chunk.length; i += 64 * 1024) {
            yield line({
              type: "data",
              value: base64(chunk.subarray(i, i + 64 * 1024)),
            });
          }
        }
      } catch {
        // The terminal remains authoritative; output loss alone is not no-start.
      }
      yield line({ type: "terminal", value: await work.completed });
    })();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const item = await iterator.next();
            if (item.done) controller.close();
            else controller.enqueue(item.value);
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel(reason) {
          await work.cancel(String(reason ?? "controller_cancelled"));
          await iterator.return();
        },
      }),
      {
        headers: {
          "content-type": "application/x-ndjson",
          "x-copilotz-operation": work.operationId,
          "x-copilotz-stream": work.streamId,
        },
      },
    );
  };
}
/** Stateless client: one request, no retry, and no inference of no-start from proxies. */
export function createShardController(options: {
  url: string;
  headers?: () => HeadersInit | Promise<HeadersInit>;
  fetch?: typeof fetch;
}): { dispatch(input: ShardWorkInput): Promise<WorkHandle> } {
  return {
    async dispatch(input) {
      const headers = new Headers(await options.headers?.());
      headers.set("content-type", "application/json");
      const body = input.body instanceof Uint8Array
        ? input.body
        : await boundedBody(input.body ?? null);
      const abort = new AbortController();
      const signal = input.signal
        ? AbortSignal.any([abort.signal, input.signal])
        : abort.signal;
      const response = await (options.fetch ?? fetch)(
        new URL(SHARD_WORK_PATH, options.url),
        {
          method: "POST",
          redirect: "error",
          headers,
          signal,
          body: JSON.stringify({
            ...input,
            signal: undefined,
            body: base64(body),
          }),
        },
      );
      if (!response.ok || !response.body) {
        const error = await response.json().catch(() => ({}));
        throw new ShardDispatchError(
          error.error ?? "shard_unavailable",
          `Shard returned ${response.status}`,
          error.started === false ? false : undefined,
        );
      }
      const completed = Promise.withResolvers<
        Awaited<WorkHandle["completed"]>
      >();
      const metadata = Promise.withResolvers<Awaited<WorkHandle["metadata"]>>();
      void completed.promise.catch(() => undefined);
      void metadata.promise.catch(() => undefined);
      const reader = response.body.pipeThrough(new TextDecoderStream())
        .getReader();
      let buffer = "";
      let terminal = false;
      const fail = (error: unknown) => {
        completed.reject(error);
        metadata.reject(error);
      };
      const output = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            while (true) {
              const index = buffer.indexOf("\n");
              if (index >= 0) {
                const item = JSON.parse(buffer.slice(0, index));
                buffer = buffer.slice(index + 1);
                if (item.type === "data") {
                  controller.enqueue(unbase64(item.value));
                  return;
                }
                if (item.type === "metadata") metadata.resolve(item.value);
                else if (item.type === "terminal") {
                  terminal = true;
                  completed.resolve(item.value);
                  metadata.resolve({});
                  controller.close();
                  await reader.cancel();
                  return;
                } else throw new Error("Invalid shard frame.");
              } else {
                if (buffer.length > 256 * 1024) {
                  throw new Error("Shard frame too large.");
                }
                const item = await reader.read();
                if (item.done) {
                  throw new ShardDispatchError(
                    "indeterminate",
                    "Shard output ended without a terminal.",
                  );
                }
                buffer += item.value;
              }
            }
          } catch (error) {
            fail(error);
            controller.error(error);
            await reader.cancel().catch(() => undefined);
          }
        },
        async cancel(reason) {
          abort.abort(reason);
          if (!terminal) {
            fail(
              new ShardDispatchError("indeterminate", "Controller cancelled."),
            );
          }
          await reader.cancel(reason).catch(() => undefined);
        },
      });
      return {
        operationId: response.headers.get("x-copilotz-operation") ?? "",
        streamId: response.headers.get("x-copilotz-stream") ?? "",
        metadata: metadata.promise,
        output,
        started: Promise.resolve(),
        completed: completed.promise,
        cancel(reason) {
          abort.abort(reason);
          fail(
            new ShardDispatchError("indeterminate", "Controller cancelled."),
          );
          return completed.promise;
        },
      };
    },
  };
}
