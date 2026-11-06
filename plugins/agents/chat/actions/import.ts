/**
 * `chat.import`: a conversation moving in from another app, as it was: its
 * thread (`thread`, the importer's id) in a space, with its title, and its
 * messages, each with who said it (`from`: a person's id or an agent's
 * name), to whom, what, its files and when (`at`). Nothing runs: no turn,
 * no transcript, nothing delivered. Moving in says what was said; it doesn't
 * say it again.
 *
 * - **Its ids are the importer's:** importing again replaces what it made,
 *   never repeating it, and a long conversation comes in several calls. After
 *   each, the thread's count, first and latest are worked out from every
 *   message it has, and it last moved (`at`) when its latest one was said,
 *   or later when the call says so (the other app's own time).
 * - **Files** come with their content (`data`, base64), or name a document
 *   that holds one as `type` and `data` (`id`, in chat's `file` collection
 *   unless `collection` says another): its content is reused. Content is a
 *   blob, by the hash of what it holds, so the same file twice is kept once.
 *   A file's id is its message's with its place (`<message>:file.0`), as a
 *   file people send.
 * - **Times** are ISO 8601 with their zone (`Z` or an offset), kept to the
 *   millisecond: conversations read oldest first by them.
 * - **Agents:** whom a new message there goes to, by default (`agents`),
 *   else who answers new chats in its space.
 *
 * The system's alone (a migration), and unrecorded: its input is the
 * conversation itself, and the documents it writes are their own record.
 * Processors that follow messages (history's summaries) take imported ones
 * as any.
 */
import { type Context, defineAction, failure, invalid } from "../../../../runtime/mod.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import { rosterOf } from "../shared/agents.ts";
import { MEDIA_TYPE, MEDIA_TYPE_LENGTH } from "./send.ts";

/** The most a file's content may be, as base64 (about 10 MB): as a person's file. */
const FILE_DATA = 14_000_000;

/** A time with its zone: `2025-03-01T12:00:00Z`, `2025-03-01T09:00:00.123-03:00`. */
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const names = { type: "array", items: { type: "string", minLength: 1 }, maxItems: 20 } as const;
const time = { type: "string", maxLength: 40 } as const;

/** A file to import: given as it is (`data`), or a document holding one (`id`, `collection`). */
type Given = {
  name?: string;
  type?: string;
  data?: string;
  id?: string;
  collection?: string;
  voice?: { duration: number; peaks?: number[] };
  transcript?: string;
};

/** A time as the store keeps it (`toISOString`), or `invalid` naming what it was. */
function isoOf(value: string, what: string): string {
  const ms = ZONED.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw invalid(`${what}: a time with its zone (ISO 8601), not "${value}"`);
  return new Date(ms).toISOString();
}

/** How large a file given as base64 is, in bytes. */
const sizeOf = (data: string) => Math.floor(data.replace(/=+$/, "").length * 3 / 4);

/** A file as given, or as the document it names holds it, checked as a person's file is. */
async function fileOf(ctx: Context, given: Given, which: string) {
  if ((given.id === undefined) === (given.data === undefined)) {
    throw invalid(`${which}: its \`data\`, or the \`id\` of a document holding it, one of them`);
  }
  let found: { name?: unknown; type?: unknown; data?: unknown } = given;
  if (given.id !== undefined) {
    const collection = given.collection ?? "file";
    const doc = await ctx.db.collection<Record<string, unknown>>(collection)
      .findOne({ _id: given.id });
    if (!doc) throw failure("not_found", `${which}: no "${given.id}" in ${collection}`);
    found = { name: given.name ?? doc.name, type: given.type ?? doc.type, data: doc.data };
  }
  const { name, type, data } = found;
  if (typeof name !== "string" || !name) throw invalid(`${which}: its name`);
  if (typeof type !== "string" || type.length > MEDIA_TYPE_LENGTH || !MEDIA_TYPE.test(type)) {
    throw invalid(`${which}: a media type, as \`type/subtype\``);
  }
  if (typeof data !== "string") throw invalid(`${which}: its content, as base64`);
  if (data.length > FILE_DATA) throw invalid(`${which} is larger than a message's file may be`);
  return {
    name,
    type,
    data,
    size: sizeOf(data),
    ...(given.voice ? { voice: given.voice } : {}),
    ...(given.transcript !== undefined ? { transcript: given.transcript } : {}),
  };
}

export const importAction = defineAction({
  description: "Brings in a conversation from another app, as it was, without running anything",
  record: false,
  input: {
    type: "object",
    properties: {
      /** The thread's id, the importer's: importing it again replaces what it made. */
      thread: { type: "string", minLength: 1, maxLength: 200 },
      /** The space it's in. */
      in: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1, maxLength: 300 },
      /** Whom a new message there goes to; by default, who answers new chats in its space. */
      agents: names,
      /** When it last moved, as the other app had it; by default, when its latest message was said. */
      at: time,
      messages: {
        type: "array",
        maxItems: 500,
        items: {
          type: "object",
          properties: {
            /** The message's id, the importer's. */
            id: { type: "string", minLength: 1, maxLength: 300 },
            /** Who said it: a person's id, or an agent's name. */
            from: { type: "string", minLength: 1 },
            to: names,
            text: { type: "string" },
            files: {
              type: "array",
              maxItems: 10,
              items: {
                type: "object",
                properties: {
                  name: { type: "string", minLength: 1, maxLength: 255 },
                  type: {
                    type: "string",
                    maxLength: MEDIA_TYPE_LENGTH,
                    pattern: MEDIA_TYPE.source,
                  },
                  /** Its content, base64. */
                  data: { type: "string", maxLength: FILE_DATA },
                  /** Or a document holding it as `type` and `data`: chat's own files by default. */
                  id: { type: "string", minLength: 1 },
                  collection: { type: "string", minLength: 1 },
                  /** A recording's length (ms) and loudness over time, for its player. */
                  voice: {
                    type: "object",
                    properties: {
                      duration: { type: "number", minimum: 0 },
                      peaks: {
                        type: "array",
                        maxItems: 64,
                        items: { type: "number", minimum: 0, maximum: 1 },
                      },
                    },
                    required: ["duration"],
                    additionalProperties: false,
                  },
                  /** What an audio file says. */
                  transcript: { type: "string" },
                },
                additionalProperties: false,
              },
            },
            /** When it was said, with its zone. */
            at: time,
          },
          required: ["id", "from", "at"],
          additionalProperties: false,
        },
      },
    },
    required: ["thread", "messages"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const threads = ctx.db.collection<Thread>("thread");
    const existing = await threads.findOne({ _id: input.thread });
    // A conversation moves between spaces with everything in it (`chat.move`), never by an import.
    if (existing && input.in && existing.in !== input.in) {
      throw invalid(`Chat "${input.thread}" is in another space: chat.move moves it.`);
    }
    const where = existing?.in ?? input.in;
    const moved = input.at ? isoOf(input.at, "The thread's time") : undefined;
    const agents = input.agents ?? existing?.agents ?? (await rosterOf(ctx, where)).default;
    const seen = new Set<string>();
    const messages: Message[] = [];
    const files: Record<string, unknown>[] = [];
    for (const [n, given] of input.messages.entries()) {
      if (seen.has(given.id)) throw invalid(`Message "${given.id}" is given twice.`);
      seen.add(given.id);
      const at = isoOf(given.at, `Message ${n + 1}`);
      const own = await Promise.all((given.files ?? []).map(async (file, i) => ({
        _id: `${given.id}:file.${i}`,
        ...await fileOf(ctx, file as Given, `Message ${n + 1}, file ${i + 1}`),
        thread: input.thread,
        ...(where ? { in: where } : {}),
        at,
      })));
      if (!given.text?.trim() && !own.length) {
        throw invalid(`Message ${n + 1} says something, or has a file.`);
      }
      files.push(...own);
      messages.push({
        _id: given.id,
        thread: input.thread,
        ...(where ? { in: where } : {}),
        from: given.from,
        to: given.to ?? [],
        text: given.text ?? "",
        ...(own.length
          ? {
            files: own.map((f) => ({
              id: f._id,
              name: f.name,
              type: f.type,
              size: f.size,
              ...(f.voice ? { voice: f.voice } : {}),
              ...(f.transcript !== undefined ? { transcript: f.transcript } : {}),
            })),
          }
          : {}),
        at,
      });
    }
    await ctx.transaction(async (tx) => {
      const replace = (collection: string, doc: { _id: string }) =>
        tx.db.collection(collection).replaceOne({ _id: doc._id }, doc, {
          upsert: true,
          writeConcern: { w: 0 },
        });
      await tx.db.collection<Thread>("thread").updateOne({ _id: input.thread }, {
        $set: {
          ...(where ? { in: where } : {}),
          ...(input.title ? { title: input.title } : {}),
          agents,
          at: existing?.at ?? moved ?? messages[0]?.at ?? new Date().toISOString(),
        },
      }, { upsert: true });
      for (const file of files) await replace("file", file as { _id: string });
      for (const message of messages) await replace("message", message);
      // Its summary, from every message it has now (this call's writes included).
      const all = tx.db.collection<Message>("message");
      const shared = { thread: input.thread, private: { $ne: true } };
      const [count, [first], [last]] = await Promise.all([
        all.countDocuments(shared),
        all.find(shared, { sort: { at: 1 }, limit: 1 }),
        all.find(shared, { sort: { at: -1 }, limit: 1 }),
      ]);
      const latest = [last?.at, moved].filter((t): t is string => !!t).sort().at(-1);
      await tx.db.collection<Thread>("thread").updateOne({ _id: input.thread }, {
        $set: {
          messages: count,
          ...(first ? { opened: first._id } : {}),
          ...(last ? { latest: last._id } : {}),
          ...(latest ? { at: latest } : {}),
        },
      });
    });
    return { thread: input.thread, messages: messages.length, files: files.length };
  },
});
