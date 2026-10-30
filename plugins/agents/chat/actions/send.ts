/**
 * A person's message. It goes to `to` when given, else to the agents
 * `@mentioned` in it, else to the sender of the message it replies to,
 * else to the thread's agents (a new thread's: those it names, or who
 * answers new chats in its space). Only agents answering in its space
 * answer there: naming one that doesn't fails (`not_here`). Audio sent with it is transcribed first
 * (what agents read): if that fails, nothing is sent and the call fails
 * with `transcription_failed`; `transcribe: false` sends it as it is.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Transcript } from "../../../models/contract.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import { agentsNamed, mentions, NO_ANSWER, now, rosterOf } from "../shared/agents.ts";
import { delivery } from "../shared/delivery.ts";
import { movedBy, startedWith } from "../shared/summary.ts";
import { settingsOf } from "../shared/types.ts";

const names = { type: "array", items: { type: "string" } } as const;

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
            type: { type: "string" },
            data: { type: "string", maxLength: 14_000_000 },
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
    },
    additionalProperties: false,
  },
  // People write as themselves: their own messages.
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const said = input.text ?? "";
    if (!said.trim() && !input.files?.length) {
      throw Object.assign(new Error("A message says something, or sends a file"), {
        code: "invalid",
      });
    }
    const threads = ctx.db.collection<Thread>("thread");
    const threadId = input.thread ?? crypto.randomUUID();
    const existing = input.thread ? await threads.findOne({ _id: threadId }) : null;
    const replied = input.replyTo
      ? await ctx.db.collection<Message>("message").findOne({ _id: input.replyTo })
      : null;
    const where = existing ? existing.in : input.in;
    const roster = await rosterOf(ctx, where);
    const members = existing ? existing.agents ?? [] : roster.default;
    const mentioned = mentions(said);
    const asked = input.to ??
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
    const named = to.filter((name) => agents[name]);
    const joined = existing ? members : named.length ? named : members;
    const id = crypto.randomUUID();
    // What audio says, before anything is sent: agents read it.
    const transcripts = await Promise.all((input.files ?? []).map(async (f) => {
      if (input.transcribe === false || !f.type?.startsWith("audio/")) return undefined;
      try {
        const heard = await ctx.call<Transcript>("transcription.transcribe", {
          model: settingsOf(ctx).transcriber ?? "transcribe",
          audio: f.data,
          type: f.type,
          filename: f.name,
          tags: { thread: threadId, purpose: "transcription" },
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
      size: Math.floor(f.data.replace(/=+$/, "").length * 3 / 4),
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
      from: ctx.actor?.kind === "person" ? ctx.actor.id : input.from ?? "user",
      ...(where ? { in: where } : {}),
      to: [...to],
      text: said,
      hops: 0,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      at: now(),
    };
    const deliver = await delivery(ctx, sent);
    await ctx.transaction(async (tx) => {
      // The chat's summary moves with the write that touches it anyway.
      if (existing) {
        await tx.db.collection("thread").updateOne({ _id: threadId }, movedBy(sent), NO_ANSWER);
      } else {
        await tx.db.collection("thread").insertOne({
          _id: threadId,
          agents: joined,
          ...(where ? { in: where } : {}),
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
