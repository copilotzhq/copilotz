/**
 * A model call on a plan's CLI (see shared/engines.ts), for the `engine`
 * model adapter (adapters/engine.ts): one step of an agent's turn, run on a
 * computer of the person it works for, its events as they come
 * (`computer.agents.prompt`, see shared/workloads.ts). Called inline, from
 * the turn's job: the stream is handed back as it is.
 *
 * Only while someone's there: a turn a routine set going (no one present)
 * fails, and its model list moves on (to an API key). The first event says
 * which computer it ran on, for the adapter to come back to it.
 */
import { defineAction, failure, people, personOf } from "../../../../runtime/mod.ts";
import { originOf } from "../../../agents/chat/contract.ts";
import {
  engineComputer,
  engineFailure,
  type EngineName,
  ENGINES,
  signedOut,
} from "../shared/engines.ts";
import { failed } from "../shared/failed.ts";
import { touch, wake } from "../shared/wake.ts";
import { type PromptEvent, WORK } from "../shared/workloads.ts";

/** One step's events, and which computer they come from. */
export type EngineEvent = PromptEvent | { type: "computer"; computer: string };

const decoder = new TextDecoder();

/** JSON lines from a job's output, one value each. */
async function* lines(output: ReadableStream<Uint8Array>): AsyncGenerator<PromptEvent> {
  let buffer = "";
  for await (const chunk of output) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line) yield JSON.parse(line) as PromptEvent;
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as PromptEvent;
}

export const engineAction = defineAction({
  description: "Runs one step of an agent's model call on its person's plan, on their computer",
  // What goes through is the conversation and the agent's instructions: never recorded.
  record: false,
  input: {
    type: "object",
    properties: {
      engine: { enum: [...ENGINES] },
      model: { type: "string" },
      /** The computer an earlier step ran on, to come back to (its session lives there). */
      computer: { type: "string" },
      session: { type: "string" },
      instructions: { type: "string" },
      tools: { type: "array" },
      prompt: { type: "array" },
      id: { type: "string" },
      from: { type: "integer", minimum: 0 },
      results: { type: "array" },
    },
    required: ["engine", "model", "instructions", "tools", "prompt", "id"],
    additionalProperties: false,
  },
  allow: people,
  run: async function* (ctx, input): AsyncGenerator<EngineEvent> {
    const person = personOf(ctx.actor);
    if (!person) throw failure("forbidden", "A plan runs only for a person.", { public: true });
    if (originOf(ctx.actor)) {
      throw engineFailure(
        "engine_unattended",
        "A plan's CLI runs only while its person is there: this runs on its own.",
      );
    }
    const computer = await engineComputer(ctx, person, input.engine as EngineName, input.computer);
    // A session lives on the computer that started it: another computer starts afresh.
    const same = computer._id === input.computer;
    if (!computer.online) {
      const woke = await wake(ctx, computer._id);
      if (woke !== true) {
        throw engineFailure(
          "engine_offline",
          typeof woke === "string"
            ? woke
            : `${computer.name ?? "Your computer"} is offline: your plan runs there.`,
        );
      }
    }
    const touched = touch(ctx, computer._id);
    yield { type: "computer", computer: computer._id };
    // Its session, or the answer it was in, is on another computer: a fresh one, given it all.
    if (!same && (input.session || input.from !== undefined || input.results)) {
      await touched;
      yield {
        i: 0,
        type: "failed",
        code: "stale",
        message: "The session is on another computer: start afresh here",
      };
      return;
    }
    const job = await ctx.workers.dispatch("computer", computer._id, WORK.agentsPrompt, {
      engine: input.engine,
      model: input.model,
      ...(same && input.session ? { session: input.session } : {}),
      instructions: input.instructions,
      tools: input.tools,
      prompt: input.prompt,
      id: input.id,
      ...(same && input.from !== undefined ? { from: input.from } : {}),
      ...(same && input.results ? { results: input.results } : {}),
    }, { signal: ctx.signal }).catch((error) => {
      throw (error as { code?: string }).code === "offline"
        ? engineFailure("engine_offline", `${computer.name ?? "Your computer"} went offline.`)
        : error;
    });
    try {
      for await (const event of lines(job.output)) {
        // Signed out there: calls stop going to it until it's signed in again.
        if (event.type === "failed" && event.code === "signed_out") {
          await signedOut(ctx, computer._id, input.engine as EngineName);
        }
        yield event;
      }
      await job.done;
    } finally {
      await touched;
    }
  },
});

export const engineCancelAction = defineAction({
  description: "Stops what an agent's model call is doing on its person's plan",
  input: {
    type: "object",
    properties: { computer: { type: "string" }, session: { type: "string" } },
    required: ["computer", "session"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const person = personOf(ctx.actor);
    const computer = person
      ? await ctx.as().db.collection("computer").findOne({ _id: input.computer, owner: person })
      : null;
    if (!computer?.online) return { ok: false };
    const answer = await ctx.workers.call("computer", input.computer, WORK.agentsCancel, {
      session: input.session,
    });
    const error = failed(answer);
    if (error) throw error;
    return { ok: true };
  },
});
