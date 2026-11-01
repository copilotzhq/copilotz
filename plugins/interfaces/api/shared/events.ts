/**
 * What a key follows: the app's events as they commit, as server-sent
 * events, of what the key may see.
 *
 * - **Changes** to documents in its space (`message.created`…), of the
 *   collections that live in spaces (the spaces plugin's `shared`
 *   resource, and the space's own records), each with the document as the
 *   key reads it now: read again as the key, so the rules decide (sources
 *   it can't see leave it out) and private fields stay out. A deleted one
 *   says only its `_id`.
 * - **Its own calls' outcomes:** `action.completed` and `action.failed` of
 *   the calls made with this key, by call id: for a long call, to follow.
 *
 * Each event has its log position as its `id`. A comment every 20 s keeps
 * the connection open, and checks the key: revoked, the stream says so
 * (`revoked`) and ends.
 */
import type { Event, Runtime } from "../../../../runtime/mod.ts";
import type { Proven } from "../collections/key.ts";
import { CORS } from "./http.ts";

type Watching = Pick<Runtime, "query" | "subscribe" | "describe">;

/** How often the stream says it's alive (and checks its key). */
export const PING_MS = 20_000;

/** The field saying which space each of the spaces plugin's own records is in. */
const OWN: Record<string, string> = {
  space: "_id",
  member: "space",
  request: "space",
  invitation: "space",
};

const CHANGE = /^(.+)\.(created|updated|deleted)$/;

/** What a batch says: a change to a document in the key's space, or one of its calls' outcomes. */
type Said =
  | { event: Event; collection: string; _id: string; how: string }
  | { event: Event; collection?: undefined };

/** One event as the stream says it. */
const frame = (event: Event, data: Record<string, unknown>) =>
  `id: ${event.seq}\nevent: ${event.type}\ndata: ${
    JSON.stringify({ seq: event.seq, type: event.type, at: event.at, ...data })
  }\n\n`;

export function eventStream(
  runtime: Watching,
  proven: Proven,
  /** Whether the key still works (it's checked with every ping). */
  alive: () => Promise<boolean>,
  pingMs = PING_MS,
): Response {
  const { actor } = proven;
  const shared = (runtime.describe().resources.shared ?? {}) as Record<
    string,
    { field?: string } | null
  >;
  /** The field saying which space a collection's documents are in, if they are. */
  const placed = (collection: string) =>
    OWN[collection] ?? (shared[collection] ? shared[collection]!.field ?? "in" : undefined);

  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (text: string) => {
        if (open) controller.enqueue(encoder.encode(text));
      };
      let queued: Event[] = [];
      let chain = Promise.resolve();
      /** The key's own calls started since it connected, until they end. */
      const calls = new Set<string>();

      /** A batch, in order: changes read again as the key, its calls' outcomes as they are. */
      const flush = async (events: Event[]) => {
        const reread = new Map<string, Set<string>>();
        const wanted = events.flatMap((event): Said[] => {
          const change = CHANGE.exec(event.type);
          if (change) {
            const [, collection, how] = change;
            const field = placed(collection);
            const data = event.data as { _id: string; doc?: Record<string, unknown> };
            if (!field || data.doc?.[field] !== actor.within) return [];
            if (how !== "deleted") {
              if (!reread.has(collection)) reread.set(collection, new Set());
              reread.get(collection)!.add(data._id);
            }
            return [{ event, collection, _id: data._id, how }];
          }
          const mine = event.actor?.key === actor.key && event.actor?.id === actor.id;
          // Its own calls (not those they made in turn): started with no cause.
          if (mine && event.type === "action.started" && !event.cause) calls.add(event.id);
          if (
            (event.type === "action.completed" || event.type === "action.failed") &&
            event.cause && calls.delete(event.cause)
          ) {
            return [{ event }];
          }
          return [];
        });
        if (!wanted.length) return;
        // What the key reads of them now: one read per collection.
        const read = new Map<string, Map<string, unknown>>();
        await Promise.all([...reread].map(async ([collection, ids]) => {
          const docs = await runtime.query<{ _id: string }[]>(
            "api_key.see",
            { collection, ids: [...ids] },
            { actor },
          ).catch(() => []);
          read.set(collection, new Map(docs.map((doc) => [doc._id, doc])));
        }));
        for (const one of wanted) {
          const { event } = one;
          if (one.collection === undefined) {
            const data = event.data as Record<string, unknown>;
            send(frame(event, {
              call: event.cause,
              action: data.action,
              ...(event.type === "action.completed"
                ? { result: data.result }
                : { error: data.error }),
            }));
            continue;
          }
          const { collection, _id, how } = one;
          if (how === "deleted") {
            send(frame(event, { collection, _id }));
            continue;
          }
          const doc = read.get(collection)?.get(_id);
          // Not something the key may read (its sources, say): nothing is said of it.
          if (!doc) continue;
          const changed = (event.data as { changed?: string[] }).changed;
          send(frame(event, { collection, _id, doc, ...(changed ? { changed } : {}) }));
        }
      };

      const unsubscribe = runtime.subscribe((item) => {
        if (item.kind !== "event") return;
        queued.push(item.event);
        // What one commit published goes as one batch.
        if (queued.length === 1) {
          setTimeout(() => {
            const batch = queued;
            queued = [];
            chain = chain.then(() => flush(batch)).catch(() => {});
          }, 0);
        }
      });
      const ping = setInterval(async () => {
        if (!await alive().catch(() => true)) {
          send(
            'event: revoked\ndata: {"error":{"code":"unauthorized","message":"The key was revoked."}}\n\n',
          );
          stop();
          try {
            controller.close();
          } catch {
            // Already closed by the caller going away.
          }
          return;
        }
        send(": ping\n\n");
      }, pingMs);
      stop = () => {
        open = false;
        unsubscribe();
        clearInterval(ping);
      };
      send(`retry: 3000\n: following ${actor.within}\n\n`);
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      ...CORS,
    },
  });
}
