/**
 * What a key follows: the app's events as they commit, as server-sent
 * events, of what the key may see. It follows the rules, the API's own: the
 * key's scope says what it may ask for, not what it's told of.
 *
 * - **Changes** to documents of the collections that live in spaces (the
 *   spaces plugin's `shared` resource, and its own records), in the spaces
 *   the key reads (`message.created`…), each with the document as the key
 *   reads it now: read again as the key, so the rules decide (sources it
 *   can't see leave it out) and private fields stay out. A deleted one says
 *   only its `_id`. Keys themselves are never told of.
 * - **Its own calls' outcomes:** `action.completed` and `action.failed` of
 *   the calls made with this key, by call id: for a long call, to follow.
 *
 * Each event has its log position as its `id`. The key revoked, the stream
 * says so (`revoked`) and ends, at once; a comment every 20 s keeps the
 * connection open, and checks the key again.
 */
import type { Actor, Event, Feed, Runtime } from "../../../../runtime/mod.ts";
import type { KeyActor } from "./actor.ts";
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

/** An event as it's published. */
type Published = Extract<Feed, { kind: "event" }>;

/** What a batch says: a change to a document the key may see, or one of its calls' outcomes. */
type Said =
  | { event: Event; collection: string; _id: string; how: string; space: string }
  | { event: Event; collection?: undefined; full: Published["full"] };

/** One event as the stream says it. */
const frame = (event: Event, data: Record<string, unknown>) =>
  `id: ${event.seq}\nevent: ${event.type}\ndata: ${
    JSON.stringify({ seq: event.seq, type: event.type, at: event.at, ...data })
  }\n\n`;

const REVOKED =
  'event: revoked\ndata: {"error":{"code":"unauthorized","message":"The key was revoked."}}\n\n';

export function eventStream(
  runtime: Watching,
  actor: KeyActor,
  /** Whether the key still works (it's checked with every ping). */
  alive: () => Promise<boolean>,
  pingMs = PING_MS,
): Response {
  // Read as the key reaches, by the rules: the stream is the API's, whatever the scope lists.
  const reader: Actor = { kind: actor.kind, id: actor.id, key: actor.key };
  const see = (collection: string, ids: string[]) =>
    runtime.query<{ _id: string }[]>("api_key.see", { collection, ids }, { actor: reader })
      .catch(() => []);
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
      const end = () => {
        send(REVOKED);
        stop();
        try {
          controller.close();
        } catch {
          // Already closed by the caller going away.
        }
      };
      let queued: Published[] = [];
      let chain = Promise.resolve();
      /** The key's own calls started since it connected, until they end. */
      const calls = new Set<string>();
      /** Whether the key reads each space, as the rules said; asked again as who's where changes. */
      const reads = new Map<string, boolean>();

      /** A batch, in order: changes read again as the key, its calls' outcomes as they are. */
      const flush = async (events: Published[]) => {
        const wanted = events.flatMap(({ event, full }): Said[] => {
          const change = CHANGE.exec(event.type);
          if (change) {
            const [, collection, how] = change;
            const field = placed(collection);
            const data = event.data as { _id: string; doc?: Record<string, unknown> };
            const space = data.doc?.[field ?? ""];
            if (!field || collection === "api_key" || typeof space !== "string") return [];
            return [{ event, collection, _id: data._id, how, space }];
          }
          const mine = event.actor?.key === actor.key && event.actor?.id === actor.id;
          // Its own calls (not those they made in turn): started with no cause.
          if (mine && event.type === "action.started" && !event.cause) calls.add(event.id);
          if (
            (event.type === "action.completed" || event.type === "action.failed") &&
            event.cause && calls.delete(event.cause)
          ) {
            return [{ event, full }];
          }
          return [];
        });
        if (!wanted.length) return;
        // Who's where changed: which spaces the key reads is asked again.
        if (wanted.some((one) => one.collection === "member" || one.collection === "space")) {
          reads.clear();
        }
        const unknown = [
          ...new Set(
            wanted.flatMap((one) => one.collection && !reads.has(one.space) ? [one.space] : []),
          ),
        ];
        if (unknown.length) {
          const found = new Set((await see("space", unknown)).map((s) => s._id));
          for (const space of unknown) reads.set(space, found.has(space));
        }
        // What the key reads of them now: one read per collection, in the spaces it reads.
        const reread = new Map<string, Set<string>>();
        for (const one of wanted) {
          if (!one.collection || one.how === "deleted" || !reads.get(one.space)) continue;
          if (!reread.has(one.collection)) reread.set(one.collection, new Set());
          reread.get(one.collection)!.add(one._id);
        }
        const read = new Map<string, Map<string, unknown>>();
        await Promise.all([...reread].map(async ([collection, ids]) => {
          const docs = await see(collection, [...ids]);
          read.set(collection, new Map(docs.map((doc) => [doc._id, doc])));
        }));
        for (const one of wanted) {
          const { event } = one;
          if (one.collection === undefined) {
            // Whole: a result over 16 KiB is a blob reference in the log (its blob gone: as it is).
            const data = (await one.full().catch(() => event)).data as Record<string, unknown>;
            send(frame(event, {
              call: event.cause,
              action: data.action,
              ...(event.type === "action.completed"
                ? { result: data.result }
                : { error: data.error }),
            }));
            continue;
          }
          const { collection, _id, how, space } = one;
          if (!reads.get(space)) continue;
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
        // Revoked (or ended with its person's place): said at once.
        if (item.event.type === "api_key.deleted" && item.event.data._id === actor.key) {
          return end();
        }
        queued.push(item);
        // What one commit published goes as one batch.
        if (queued.length === 1) {
          setTimeout(() => {
            const batch = queued;
            queued = [];
            chain = chain.then(() => open ? flush(batch) : undefined).catch(() => {});
          }, 0);
        }
      });
      const ping = setInterval(async () => {
        if (!await alive().catch(() => true)) return end();
        send(": ping\n\n");
      }, pingMs);
      stop = () => {
        open = false;
        unsubscribe();
        clearInterval(ping);
      };
      send(`retry: 3000\n: following what key ${actor.key} may see\n\n`);
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
