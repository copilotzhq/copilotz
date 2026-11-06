/**
 * `chat.say`: an agent (`from`) says something in a chat without thinking
 * it, no model call and no turn: a fixed message trusted code decides on (a
 * payment confirmed, a picture a tool made). It goes to `to` (people by id,
 * contacts as `contact:<id>`), else to whoever last wrote there who isn't an
 * agent, and out through the chat's place (WhatsApp) like any of its
 * answers. It's said to people, never to agents, so it starts no turn, by an
 * agent that answers there. Its `id` comes from what caused it (a payment's):
 * saying it again in that chat sends nothing (the message is
 * `<thread>:say:<id>`). Only trusted code calls it.
 *
 * It may carry files, as a person's message does, and may then say nothing
 * else. Each is a document the caller reads that holds a file as `type` and
 * `data` (base64): one of chat's own files (`{ id }`), or another plugin's
 * (`{ id, collection: "image" }`, a picture the models plugin made). Or it's
 * given as it is (`{ name, type, data }`). Each becomes a file of the chat,
 * where its people and contacts read it. Its content is a blob, by the hash of
 * what it holds, so a file already kept elsewhere isn't stored again. Files
 * meet the limits people's do: ten at most, about 10 MB each, a media type
 * as `chat.send` takes one.
 */
import { type Context, defineAction, failure, invalid } from "../../../../runtime/mod.ts";
import { FILE_DATA, sizeOf } from "../collections/file.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import { agentsNamed, now, rosterOf } from "../shared/agents.ts";
import { noted } from "../shared/summary.ts";
import { MEDIA_TYPE, MEDIA_TYPE_LENGTH } from "./send.ts";

/** A file to say: a document the caller reads (`id`, `collection`), or one given as it is (`data`). */
type Given = { id?: string; collection?: string; name?: string; type?: string; data?: string };

/** What a file's name says of its kind when nothing names it: `image.png`. */
const nameFor = (type: string) => {
  const [kind, sub = "bin"] = type.split(";")[0].trim().toLowerCase().split("/");
  const extension = sub === "jpeg" ? "jpg" : sub.split("+")[0].replace(/[^a-z0-9]/g, "") || "bin";
  return `${kind}.${extension}`;
};

/** A file as given or as read (as the caller, so the rules decide), checked as people's are. */
async function fileOf(ctx: Context, given: Given, n: number) {
  const which = `File ${n + 1}`;
  if ((given.id === undefined) === (given.data === undefined)) {
    throw invalid(`${which}: an \`id\` (and its \`collection\`) or \`data\`, one of them`);
  }
  let found: { name?: unknown; type?: unknown; data?: unknown } = given;
  if (given.id !== undefined) {
    const collection = given.collection ?? "file";
    const doc = await ctx.db.collection<Record<string, unknown>>(collection)
      .findOne({ _id: given.id });
    if (!doc) throw failure("not_found", `${which}: no "${given.id}" in ${collection} to read`);
    found = { name: given.name ?? doc.name, type: given.type ?? doc.type, data: doc.data };
  }
  const { type, data } = found;
  if (typeof type !== "string" || type.length > MEDIA_TYPE_LENGTH || !MEDIA_TYPE.test(type)) {
    throw invalid(`${which}: a media type, as \`type/subtype\``);
  }
  if (typeof data !== "string" || !data) throw invalid(`${which}: its content, as base64`);
  if (data.length > FILE_DATA) throw invalid(`${which} is larger than a message's file may be`);
  const name = typeof found.name === "string" && found.name ? found.name : nameFor(type);
  return { name, type, data, size: sizeOf(data) };
}

export const sayAction = defineAction({
  description: "An agent's fixed message in a chat, with files if any, without a model call",
  input: {
    type: "object",
    properties: {
      /** The message's id, from what caused it: the same id is said once. */
      id: { type: "string", minLength: 1, maxLength: 200 },
      thread: { type: "string" },
      /** The agent saying it. */
      from: { type: "string" },
      /** What it says; a message with files may say nothing else. */
      text: { type: "string" },
      to: { type: "array", items: { type: "string" }, maxItems: 20 },
      /** Files it carries: a document the caller reads (`id`, `collection`), or given (`data`). */
      files: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          properties: {
            /** A document holding the file as `type` and `data`: chat's own files by default. */
            id: { type: "string", minLength: 1 },
            collection: { type: "string", minLength: 1 },
            /** Its name as people see it: the document's, else one from its type (`image.png`). */
            name: { type: "string", minLength: 1, maxLength: 255 },
            type: { type: "string", maxLength: MEDIA_TYPE_LENGTH, pattern: MEDIA_TYPE.source },
            /** Its content, base64, when it's given as it is. */
            data: { type: "string", maxLength: FILE_DATA },
          },
          additionalProperties: false,
        },
      },
    },
    required: ["id", "thread", "from"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    if (!input.text?.trim() && !input.files?.length) {
      throw invalid("A message says something, or sends a file");
    }
    const messages = ctx.db.collection<Message>("message");
    // Its id is the chat's own: a cause says it once in each chat, and never anywhere else.
    const id = `${input.thread}:say:${input.id}`;
    const fileIds = (input.files ?? []).map((_, i) => `${id}:file.${i}`);
    const answer = { message: id, ...(fileIds.length ? { files: fileIds } : {}) };
    if (await messages.findOne({ _id: id })) return answer;
    const thread = await ctx.db.collection<Thread>("thread").findOne({ _id: input.thread });
    if (!thread) throw failure("not_found", `No chat "${input.thread}".`);
    // Said by an agent that answers there.
    const roster = await rosterOf(ctx, thread.in);
    if (!roster.here.includes(input.from) && !thread.agents?.includes(input.from)) {
      throw failure("not_here", `${input.from} doesn't answer in this chat.`);
    }
    // Whoever last wrote there who isn't an agent, unless it says whom.
    const latest = input.to ? [] : await messages.find(
      { thread: thread._id, private: { $ne: true } },
      { sort: { at: -1 }, limit: 20 },
    );
    const agents = await agentsNamed(ctx, [
      input.from,
      ...input.to ?? latest.map((m) => m.from),
    ]);
    if (!agents[input.from]) throw invalid(`No agent "${input.from}".`);
    const last = latest.find((m) => !agents[m.from])?.from;
    const to = input.to ?? (last ? [last] : []);
    if (to.some((name) => agents[name])) {
      throw invalid("An agent says this to people: to ask another agent, send it a message.");
    }
    const at = now();
    // Files of the chat, where its people and contacts read them, as people's are.
    const files = await Promise.all(
      (input.files ?? []).map(async (given, i) => ({
        _id: fileIds[i],
        ...await fileOf(ctx, given as Given, i),
        thread: thread._id,
        ...(thread.in ? { in: thread.in } : {}),
        at,
      })),
    );
    const said = {
      _id: id,
      thread: thread._id,
      ...(thread.in ? { in: thread.in } : {}),
      from: input.from,
      to,
      text: input.text ?? "",
      ...(files.length
        ? { files: files.map((f) => ({ id: f._id, name: f.name, type: f.type, size: f.size })) }
        : {}),
      // After a person's message, as an agent's answer is.
      hops: 1,
      at,
    };
    try {
      await ctx.transaction(async (tx) => {
        if (files.length) await tx.db.collection("file").insertMany(files);
        await tx.db.collection("message").insertOne(said);
        await noted(tx, said);
      });
    } catch (error) {
      // Said just now, by the same cause.
      if ((error as { code?: string }).code !== "duplicate_key") throw error;
    }
    return answer;
  },
});
