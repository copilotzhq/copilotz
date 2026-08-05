/** Runtime-neutral HTTP helpers for exposing a Copilotz v2 engine. */

import type { Copilotz } from "@/engine.ts";
import type { RunOptions } from "@/attachments/types.ts";
import type { MessagePayload } from "@/types/resources.ts";

export interface RunRequestBody {
  message: MessagePayload;
  options?: RunOptions;
}

export interface CopilotzServerHandlers {
  run(input: RunRequestBody): ReturnType<Copilotz["run"]>;
  listEvents(options: Parameters<Copilotz["events"]["list"]>[0]): ReturnType<
    Copilotz["events"]["list"]
  >;
  retryDelivery(id: string): Promise<boolean>;
  discardDelivery(id: string): Promise<boolean>;
  maintenance(): ReturnType<Copilotz["maintenance"]>;
}

export function createCopilotzServerHandlers(
  copilotz: Copilotz,
): CopilotzServerHandlers {
  return {
    run: (input) => copilotz.run(input.message, input.options),
    listEvents: (options) => copilotz.events.list(options),
    retryDelivery: (id) => copilotz.deliveries.retry(id),
    discardDelivery: (id) => copilotz.deliveries.discard(id),
    maintenance: () => copilotz.maintenance(),
  };
}

export interface CopilotzFetchHandlerOptions {
  /** URL path prefix. Default: `/v2`. */
  basePath?: string;
  /** Optional request guard. Return a response to stop routing. */
  authorize?: (
    request: Request,
  ) => void | Response | Promise<void | Response>;
}

const encoder = new TextEncoder();

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function errorResponse(error: unknown): Response {
  const status = error instanceof SyntaxError || error instanceof TypeError
    ? 400
    : 500;
  return json({
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    },
  }, { status });
}

function normalizeBasePath(value: string | undefined): string {
  const normalized = `/${
    (value ?? "/v2").split("/").filter(Boolean).join("/")
  }`;
  return normalized === "/" ? "" : normalized;
}

/**
 * Creates a Fetch-compatible adapter. It uses only Web APIs and can be mounted
 * by Deno, Bun, Node web frameworks, browsers/service workers, or edge runtimes.
 */
export function createCopilotzFetchHandler(
  copilotz: Copilotz,
  options: CopilotzFetchHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const handlers = createCopilotzServerHandlers(copilotz);
  const basePath = normalizeBasePath(options.basePath);

  return async (request) => {
    try {
      const denied = await options.authorize?.(request);
      if (denied instanceof Response) return denied;
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "GET" && path === `${basePath}/health`) {
        return json({ ok: true });
      }

      if (request.method === "GET" && path === `${basePath}/events`) {
        const events = await handlers.listEvents({
          namespace: url.searchParams.get("namespace") ?? undefined,
          threadId: url.searchParams.get("threadId") ?? undefined,
          correlationId: url.searchParams.get("correlationId") ?? undefined,
          afterPosition: url.searchParams.get("afterPosition") ?? undefined,
          limit: url.searchParams.has("limit")
            ? Number(url.searchParams.get("limit"))
            : undefined,
        });
        return json({ events });
      }

      if (request.method === "POST" && path === `${basePath}/run`) {
        const body = await request.json() as RunRequestBody;
        if (!body.message || typeof body.message !== "object") {
          throw new TypeError("The run request requires a message object.");
        }
        const handle = await handlers.run(body);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            void (async () => {
              const write = (value: unknown) => {
                controller.enqueue(
                  encoder.encode(`${JSON.stringify(value)}\n`),
                );
              };
              try {
                write({
                  kind: "accepted",
                  eventId: handle.eventId,
                  threadId: handle.threadId,
                  correlationId: handle.correlationId,
                });
                for await (const event of handle.events) {
                  write({ kind: "event", event });
                }
                await handle.done;
                write({ kind: "settled", correlationId: handle.correlationId });
                controller.close();
              } catch (error) {
                write({
                  kind: "error",
                  correlationId: handle.correlationId,
                  error: {
                    name: error instanceof Error ? error.name : "Error",
                    message: error instanceof Error
                      ? error.message
                      : String(error),
                  },
                });
                controller.close();
              }
            })();
          },
          cancel: (reason) => handle.cancel(String(reason ?? "http_cancelled")),
        });
        return new Response(stream, {
          status: 202,
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }

      if (request.method === "POST" && path === `${basePath}/maintenance`) {
        return json(await handlers.maintenance());
      }

      const deliveryPrefix = `${basePath}/deliveries/`;
      const deliveryPath = path.startsWith(deliveryPrefix)
        ? path.slice(deliveryPrefix.length).split("/")
        : [];
      if (
        request.method === "POST" && deliveryPath.length === 2 &&
        (deliveryPath[1] === "retry" || deliveryPath[1] === "discard")
      ) {
        const id = decodeURIComponent(deliveryPath[0]);
        const changed = deliveryPath[1] === "retry"
          ? await handlers.retryDelivery(id)
          : await handlers.discardDelivery(id);
        return json({ changed });
      }

      return json(
        { error: { name: "NotFound", message: "Route not found." } },
        {
          status: 404,
        },
      );
    } catch (error) {
      return errorResponse(error);
    }
  };
}
