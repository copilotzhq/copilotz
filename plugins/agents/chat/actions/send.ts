/**
 * A person's message, or a contact's (someone outside the org, in a chat
 * shared with them: the rules keep them to it). It goes to `to` when given,
 * else to the agents `@mentioned` in it, else to the sender of the message
 * it replies to, else to the thread's agents (a new thread's: those it
 * names, or who answers new chats in its space); `to: []`, to nobody: it's
 * said, agents read it later, and none answers it (what someone did on a
 * page beside the chat). A contact's goes to the sender of what it replies
 * to, else the thread's agents: never whom it names, though it too may say
 * something to nobody (`to: []`). It replies only to a message of the same conversation that its
 * sender reads. Only agents answering in
 * its space answer there: naming one that doesn't fails (`not_here`). Audio
 * sent with it is transcribed first (what agents read): if that fails,
 * nothing is sent and the call fails with `transcription_failed`;
 * `transcribe: false` sends it as it is. `via` says what sent it for the
 * person (a routine); a new thread takes `title` and `renamable` in the same
 * commit, so its first turn already has them. `tap` says it was a choice
 * tapped (a button), not typed. With `quiet`, agents answer once the sender
 * has been quiet that long (a burst of short messages, answered together).
 *
 * A contact's message says at most `CONTACT_TEXT` characters, says nothing
 * of what sent it (`via`: never "a routine"), never titles its chat nor
 * lets an agent rename it (`title`, `renamable`: what its people see), and
 * is let in by the app's `contactSend` hooks first (the web lines': a
 * web line's limits, the files it takes, its visitor's own chat, made with
 * its first message, where it goes when it names none). A hook refuses it,
 * or says where it goes and that its audio goes untranscribed (`transcribe:
 * false`).
 * People's messages go as ever.
 */
import {
  type Actor,
  type Context,
  defineAction,
  failure,
  peopleOrContacts,
} from "../../../../runtime/mod.ts";
import type { Transcript } from "../../../models/contract.ts";
import { BASE64, FILE_DATA, sizeOf } from "../collections/file.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import {
  agentsNamed,
  handles,
  mentions,
  NO_ANSWER,
  now,
  type Roster,
  rosterOf,
} from "../shared/agents.ts";
import { delivery } from "../shared/delivery.ts";
import { movedBy, startedWith } from "../shared/summary.ts";
import { settingsOf } from "../shared/types.ts";

const names = { type: "array", items: { type: "string" } } as const;

/** The most a contact's message says: WhatsApp's own most, 4,096 characters. */
export const CONTACT_TEXT = 4_096;

/** The longest media type a file may say it is (RFC 6838's longest type or subtype name). */
export const MEDIA_TYPE_LENGTH = 127;

/**
 * What a file's media type looks like: `type/subtype`, then parameters
 * (`audio/ogg; codecs=opus`, as WhatsApp sends voice notes), on one line:
 * an agent is told it (`[file a.bin: <type>, …]`).
 */
export const MEDIA_TYPE =
  /^[A-Za-z0-9][\w!#$&^.+-]*\/[A-Za-z0-9][\w!#$&^.+-]*(?: *; *[\w!#$&^.+-]+=(?:[\w!#$&^.+-]+|"[ !#-\[\]-~]*"))* *$/;

/**
 * A `contactSend` resource: the Action that lets a contact's message in,
 * asked as the contact before anything's sent, with where it goes (`thread`,
 * when it names one), what it carries (each file's name, media type and
 * size), and `to: []` when it goes to nobody (no agent answers it: no turn
 * to pay for). It refuses it (a limit), or answers where it goes when it names no
 * chat (`thread`: the contact's own) and `transcribe: false` when its audio
 * goes untranscribed.
 */
export type ContactSend = { action: string };

/** What the app's `contactSend` hooks say of a contact's message, each in turn. */
async function letIn(
  ctx: Pick<Context, "resources" | "call">,
  asked: {
    thread?: string;
    files: { name: string; type?: string; size: number }[];
    to?: [];
  },
): Promise<{ thread?: string; transcribe?: false }> {
  const hooks = Object.values((ctx.resources.contactSend ?? {}) as Record<string, ContactSend>);
  let said: { thread?: string; transcribe?: false } = {};
  for (const hook of hooks) {
    const answer = await ctx.call<{ thread?: unknown; transcribe?: unknown } | null>(hook.action, {
      ...(asked.thread ? { thread: asked.thread } : {}),
      files: asked.files,
      ...(asked.to ? { to: asked.to } : {}),
    });
    said = {
      ...said,
      ...(typeof answer?.thread === "string" && !said.thread ? { thread: answer.thread } : {}),
      ...(answer?.transcribe === false ? { transcribe: false as const } : {}),
    };
  }
  return said;
}

/**
 * The `@word`s in `text` that name someone who can be addressed: an agent
 * (the app's, a source's, or one answering here), one of the thread's agents,
 * or a person who has spoken in or been written to in the thread. Any other
 * `@word` (a social handle, say) is plain text.
 */
async function mentionsIn(
  ctx: Pick<Context, "resources" | "call" | "db">,
  text: string,
  thread: string,
  roster: Roster,
  members: string[],
): Promise<string[]> {
  const candidates = handles(text);
  if (!candidates.length) return [];
  const agents = await agentsNamed(ctx, candidates);
  const known = new Set([...roster.here, ...members, ...Object.keys(agents)]);
  const messages = ctx.db.collection<Message>("message");
  const named: string[] = [];
  for (const name of candidates) {
    if (
      known.has(name) || await messages.findOne({ thread, $or: [{ from: name }, { to: name }] })
    ) {
      named.push(name);
    }
  }
  return mentions(text, named);
}

/** Who a message is from, pinned to whoever sends it: a person by id, a contact as `contact:<id>`. */
const fromOf = (actor?: Actor) =>
  actor?.kind === "person"
    ? actor.id
    : actor?.kind === "contact"
    ? `contact:${actor.id}`
    : undefined;

export const sendAction = defineAction({
  input: {
    type: "object",
    properties: {
      thread: { type: "string" },
      /** What it says; a message with files may say nothing (a voice message). */
      text: { type: "string" },
      from: { type: "string", minLength: 1 },
      to: names,
      replyTo: { type: "string" },
      /** Where a new thread goes (a space); an existing one stays where it is. */
      in: { type: "string" },
      /** Files to attach: each its name, media type and content (base64). */
      files: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            // A media type, as the model is told it: `type/subtype`, with parameters at most.
            type: { type: "string", maxLength: MEDIA_TYPE_LENGTH, pattern: MEDIA_TYPE.source },
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
          },
          required: ["name", "data"],
          additionalProperties: false,
        },
      },
      /** False: audio goes without a transcript (as when transcribing it failed). */
      transcribe: { type: "boolean" },
      /** What sent it for the person: a routine. Their own message still, under their name. */
      via: {
        type: "object",
        properties: {
          kind: { type: "string", minLength: 1, maxLength: 40 },
          name: { type: "string", minLength: 1, maxLength: 120 },
          // A path on this app, never another site.
          path: { type: "string", pattern: "^/[^/\\\\]", maxLength: 300 },
        },
        required: ["kind", "name"],
        additionalProperties: false,
      },
      /** What a new thread is called (an existing one keeps its name). */
      title: { type: "string", minLength: 1, maxLength: 120 },
      /**
       * A choice tapped, not typed (a button's): what it means (`id`), what it
       * said (`title`, the message's text when it says none) and the addition
       * it was in (`key`).
       */
      tap: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1, maxLength: 256 },
          title: { type: "string", maxLength: 256 },
          key: { type: "string", maxLength: 120 },
        },
        required: ["id"],
        additionalProperties: false,
      },
      /** A new thread an agent may name, as what it found. */
      renamable: { type: "boolean" },
      /**
       * Ms the sender may write on before agents answer (a customer writing in
       * bursts): they answer once it's been quiet that long, everything at once.
       */
      quiet: { type: "integer", minimum: 0, maximum: 30_000 },
    },
    additionalProperties: false,
  },
  // People and contacts write as themselves: their own messages.
  allow: peopleOrContacts,
  run: async (ctx, input) => {
    const said = input.text ?? input.tap?.title ?? "";
    if (!said.trim() && !input.files?.length) {
      throw Object.assign(new Error("A message says something, or sends a file"), {
        code: "invalid",
      });
    }
    // A contact talks with whom its chat is with: what it says names nobody else, and the app
    // lets it in first (its line's limits, the files it takes, its own chat).
    const contact = ctx.actor?.kind === "contact";
    // A contact names no agent, but may say something to nobody: no agent answers it.
    const nobody = input.to?.length === 0;
    if (contact && said.length > CONTACT_TEXT) {
      throw failure("invalid", `A message says ${CONTACT_TEXT} characters at most.`, {
        public: true,
      });
    }
    const allowed = contact
      ? await letIn(ctx, {
        ...(input.thread ? { thread: input.thread } : {}),
        files: (input.files ?? []).map((f) => ({
          name: f.name,
          ...(f.type ? { type: f.type } : {}),
          size: sizeOf(f.data),
        })),
        ...(nobody ? { to: [] as [] } : {}),
      })
      : {};
    const threads = ctx.db.collection<Thread>("thread");
    const named = input.thread ?? allowed.thread;
    const threadId = named ?? crypto.randomUUID();
    const existing = named ? await threads.findOne({ _id: threadId }) : null;
    // What it answers: a message the sender reads, in this conversation (else it answers nothing).
    const found = input.replyTo
      ? await ctx.db.collection<Message>("message").findOne({ _id: input.replyTo })
      : null;
    const replied = found?.thread === threadId ? found : null;
    const where = existing ? existing.in : input.in;
    const roster = await rosterOf(ctx, where);
    const members = existing ? existing.agents ?? [] : roster.default;
    const mentioned = contact ? [] : await mentionsIn(ctx, said, threadId, roster, members);
    const asked = (contact ? (nobody ? [] : undefined) : input.to) ??
      (mentioned.length ? mentioned : replied ? [replied.from] : members);
    // Agents answer only where they work: one named that doesn't is refused; one gone, left out.
    const agents = await agentsNamed(ctx, asked);
    const away = roster.open
      ? []
      : asked.filter((name) => agents[name] && !roster.here.includes(name));
    if (away.length && (input.to || mentioned.length)) {
      throw Object.assign(
        new Error(
          `${away.join(", ")} ${away.length === 1 ? "doesn't" : "don't"} answer here: add ${
            away.length === 1 ? "it" : "them"
          } to this space (as an editor) first.`,
        ),
        { code: "not_here", agents: away },
      );
    }
    const to = asked.filter((name) => !away.includes(name));
    // A new thread is with whom it was started with: the agents named, or the space's.
    const chosen = to.filter((name) => agents[name]);
    const joined = existing ? members : chosen.length ? chosen : members;
    const id = crypto.randomUUID();
    // What audio says, before anything is sent: agents read it.
    const transcripts = await Promise.all((input.files ?? []).map(async (f) => {
      if (input.transcribe === false || allowed.transcribe === false) return undefined;
      if (!f.type?.startsWith("audio/")) return undefined;
      try {
        const heard = await ctx.call<Transcript>("transcription.transcribe", {
          model: settingsOf(ctx).transcriber ?? "transcribe",
          audio: f.data,
          type: f.type,
          filename: f.name,
          tags: { thread: threadId, purpose: "transcription", ...(where ? { space: where } : {}) },
        });
        return heard.text.trim();
      } catch (error) {
        throw Object.assign(
          new Error(`Couldn't transcribe ${f.name}: ${(error as Error).message}`),
          { code: "transcription_failed" },
        );
      }
    }));
    const files = (input.files ?? []).map((f, i) => ({
      _id: `${id}:file.${i}`,
      name: f.name,
      type: f.type ?? "application/octet-stream",
      size: sizeOf(f.data),
      data: f.data,
      ...(f.voice ? { voice: f.voice } : {}),
      ...(transcripts[i] !== undefined ? { transcript: transcripts[i] } : {}),
      thread: threadId,
      ...(where ? { in: where } : {}),
      at: now(),
    }));
    const sent = {
      _id: id,
      ...(files.length
        ? {
          files: files.map((f) => ({
            id: f._id,
            name: f.name,
            type: f.type,
            size: f.size,
            ...(f.voice ? { voice: f.voice } : {}),
            ...(f.transcript !== undefined ? { transcript: f.transcript } : {}),
          })),
        }
        : {}),
      thread: threadId,
      from: fromOf(ctx.actor) ?? input.from ?? "user",
      ...(where ? { in: where } : {}),
      to: [...to],
      text: said,
      hops: 0,
      ...(replied ? { replyTo: replied._id } : {}),
      ...(input.via && !contact ? { via: input.via } : {}),
      ...(input.tap ? { tap: input.tap } : {}),
      at: now(),
    };
    const deliver = await delivery(ctx, sent, sent.thread, true, input.quiet ?? 0);
    await ctx.transaction(async (tx) => {
      // The chat's summary moves with the write that touches it anyway.
      if (existing) {
        await tx.db.collection("thread").updateOne({ _id: threadId }, movedBy(sent), NO_ANSWER);
      } else {
        await tx.db.collection("thread").insertOne({
          _id: threadId,
          agents: joined,
          ...(where ? { in: where } : {}),
          ...(input.title && !contact ? { title: input.title } : {}),
          ...(input.renamable && !contact ? { renamable: true } : {}),
          ...startedWith(sent),
          at: sent.at,
        });
      }
      if (files.length) await tx.db.collection("file").insertMany(files);
      await tx.db.collection("message").insertOne(sent);
      await deliver(tx);
    });
    return { thread: threadId, message: sent._id };
  },
});
