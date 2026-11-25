/**
 * A prompt's id on a person's computer: the computer keeps its prompts by
 * id, for every plan, and hands a prompt it has its answer again. In one
 * turn, the next plan or model (the first one failed) is another prompt, so
 * it gets its own id; the same step tried again keeps its id.
 */
import { assertEquals, assertNotEquals } from "@std/assert";
import { engineAdapter } from "../computers/adapters/engine.ts";
import type { LlmRequest } from "../../models/contract.ts";
import { test } from "../../../testing/mod.ts";

/** The id each call asked `computer.engine` for, on `engine` with `model`, in the same turn. */
async function idAsked(engine: string, model: string): Promise<string> {
  let id = "";
  const request = {
    connection: {
      model,
      call: (_action: string, input: { id: string }) => {
        id = input.id;
        return Promise.resolve((async function* () {
          yield { type: "computer", computer: "c-1" };
          yield { i: 0, type: "session", session: "s-1" };
          yield { i: 1, type: "done", stopReason: "end_turn" };
        })());
      },
    },
    options: { engine },
    instructions: "Lead.",
    messages: [{ role: "user", content: "which order shipped?" }],
    tags: { thread: "t-1", turn: "turn-1" },
  } as unknown as LlmRequest;
  for await (const _ of engineAdapter.generate(request)) { /* drained */ }
  return id;
}

test("a turn's next plan or model is another prompt: its id isn't the one before's", async () => {
  const antigravity = await idAsked("antigravity", "gemini-4-neon");
  const cursor = await idAsked("cursor", "gemini-4-neon");
  const claude = await idAsked("claude", "claude-opus-5-5");
  const cursorClaude = await idAsked("cursor", "claude-opus-5-5");
  assertEquals(new Set([antigravity, cursor, claude, cursorClaude]).size, 4);
  // The same step tried again is the same prompt.
  assertEquals(await idAsked("cursor", "gemini-4-neon"), cursor);
  assertNotEquals(antigravity, "");
});
