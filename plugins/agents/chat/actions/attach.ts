/**
 * `chat.attach`: a file to send, uploaded on its own before the message
 * that sends it (`chat.send`, which names it by id). It's kept as a draft:
 * its sender's (`draft`), read by nobody else, in no conversation yet. A
 * composer uploads each file as it's chosen, so sending is instant and a
 * file that can't go says so alone.
 *
 * One file a call, and unrecorded (its content isn't kept again as what
 * the call was given): a call carries at most 16 MiB to the owner, so a
 * file of about 10 MB fits, and a message of ten of them goes in ten calls.
 *
 * A contact's upload is let in by the app's `contactSend` hooks first, as a
 * message to nobody carrying it (a web line's file rules and limits). A
 * sender holds `MOST_DRAFTS` drafts at most: the oldest beyond go. What
 * isn't sent within a day goes too (`chat.prune`).
 */
import { defineAction, failure, peopleOrContacts } from "../../../../runtime/mod.ts";
import { BASE64, drafter, FILE_DATA, sizeOf } from "../collections/file.ts";
import { letIn } from "../shared/contact-send.ts";
import { now } from "../shared/agents.ts";
import { MEDIA_TYPE, MEDIA_TYPE_LENGTH } from "./send.ts";

/** The most drafts a sender holds: two messages' worth (a file taken out and another put in). */
export const MOST_DRAFTS = 20;

export const attachAction = defineAction({
  description: "Uploads a file to send: a draft that a message of yours sends, by its id",
  record: false,
  input: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 255 },
      // A media type, as the model is told it: `type/subtype`, with parameters at most.
      type: { type: "string", maxLength: MEDIA_TYPE_LENGTH, pattern: MEDIA_TYPE.source },
      /** Its content, plain base64. */
      data: { type: "string", maxLength: FILE_DATA, pattern: BASE64 },
      /** A recording's length (ms) and its loudness over time, for its player. */
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
      /** The chat it's for, when there's one: a contact's hooks are told. */
      thread: { type: "string" },
    },
    required: ["name", "data"],
    additionalProperties: false,
  },
  allow: peopleOrContacts,
  run: async (ctx, input): Promise<{ id: string; size: number }> => {
    const by = drafter(ctx.actor);
    if (!by) throw failure("forbidden", "Only people and contacts send files.");
    const type = input.type ?? "application/octet-stream";
    const size = sizeOf(input.data);
    if (ctx.actor?.kind === "contact") {
      await letIn(ctx, {
        ...(input.thread ? { thread: input.thread } : {}),
        files: [{ name: input.name, type, size }],
        to: [],
      });
    }
    const id = `file-${crypto.randomUUID()}`;
    // Written by the system, for its sender: in no conversation yet, nobody's rules place it.
    const files = ctx.as().db.collection("file");
    await files.insertOne({
      _id: id,
      name: input.name,
      type,
      size,
      data: input.data,
      ...(input.voice ? { voice: input.voice } : {}),
      draft: by,
      at: now(),
    });
    // Their oldest past the most they hold go.
    const kept = await files.find({ draft: by }, {
      sort: { at: -1, _id: -1 },
      skip: MOST_DRAFTS,
      projection: { _id: 1 },
    });
    if (kept.length) await files.deleteMany({ _id: { $in: kept.map((f) => f._id) } });
    return { id, size };
  },
});
