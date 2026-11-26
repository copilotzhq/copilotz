/**
 * A person's image, to a plan's CLI: Claude Code and Codex get it as an ACP
 * image block beside the words; an engine that takes no images (Grok, Cursor,
 * Antigravity) gets the words, and the image named as left out.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { engineAdapter } from "../computers/adapters/engine.ts";
import type { LlmRequest } from "../../models/contract.ts";
import { test } from "../../../testing/mod.ts";

type Block = { type: string; text?: string; mimeType?: string; data?: string };

/** The prompt `computer.engine` was asked, on `engine`, for a message with an image. */
async function promptOn(engine: string): Promise<Block[]> {
  let prompt: Block[] = [];
  const request = {
    connection: {
      model: "m",
      call: (_action: string, input: { prompt: Block[] }) => {
        prompt = input.prompt;
        return Promise.resolve((async function* () {
          yield { type: "computer", computer: "c-1" };
          yield { i: 0, type: "session", session: "s-1" };
          yield { i: 1, type: "done", stopReason: "end_turn" };
        })());
      },
    },
    options: { engine },
    instructions: "Lead.",
    messages: [{
      role: "user",
      text: "what's wrong here?",
      files: [{ name: "shot.png", type: "image/png", data: "iVBORw0KGgo=" }],
    }],
    tags: { thread: "t-1", turn: `turn-${engine}` },
  } as unknown as LlmRequest;
  for await (const _ of engineAdapter.generate(request)) { /* drained */ }
  return prompt;
}

test("an image goes to Claude Code and Codex as an image block; other engines are told it isn't shown", async () => {
  for (const engine of ["claude", "codex", "cursor", "antigravity"]) {
    const prompt = await promptOn(engine);
    const image = prompt.find((b) => b.type === "image");
    assert(image, `${engine} gets the image`);
    assertEquals([image.mimeType, image.data], ["image/png", "iVBORw0KGgo="]);
    assertStringIncludes(prompt[0].text ?? "", "what's wrong here?");
  }
  for (const engine of ["grok"]) {
    const prompt = await promptOn(engine);
    assertEquals(prompt.filter((b) => b.type === "image").length, 0, `${engine} gets no image`);
    assertStringIncludes(
      prompt.map((b) => b.text ?? "").join("\n"),
      "shot.png isn't shown: this model can't read image files",
    );
  }
});
