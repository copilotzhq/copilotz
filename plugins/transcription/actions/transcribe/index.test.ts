import { assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "@copilotz/copilotz/actions";
import { transcribeAudioAction } from "./index.ts";
function context(signal = new AbortController().signal): ActionContext {
  return {
    signal,
    resources: {
      transcription: {
        voice: { provider: "openai", model: "whisper-1", timeoutMs: 1000 },
      },
    },
    adapters: {
      transcription: {
        voice: { resolveApiKey: () => Promise.resolve("test") },
      },
    },
    content: {
      get: () =>
        Promise.resolve({
          id: "audio",
          state: "ready",
          mediaType: "audio/webm",
          byteLength: 3,
        }),
      authorize: () => Promise.resolve(),
      open: () =>
        Promise.resolve(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array([1, 2, 3]));
              c.close();
            },
          }),
        ),
    },
  } as unknown as ActionContext;
}
Deno.test("transcription preserves verbatim ordinary text and original audio", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({ text: "Não envie 42." }),
    )) as typeof fetch;
  try {
    assertEquals(
      await transcribeAudioAction.execute({
        assetId: "audio",
        connection: "voice",
      }, context()),
      { text: "Não envie 42.", sourceAssetId: "audio", model: "whisper-1" },
    );
  } finally {
    globalThis.fetch = original;
  }
});
Deno.test("whole operation abort interrupts stalled source acquisition", async () => {
  const controller = new AbortController();
  const c = context(controller.signal);
  let entered!: () => void;
  const started = new Promise<void>((r) => entered = r);
  Object.assign(c.content, {
    get: () => {
      entered();
      return new Promise(() => {});
    },
  });
  const pending = transcribeAudioAction.execute({
    assetId: "audio",
    connection: "voice",
  }, c);
  await started;
  controller.abort(new Error("cancelled source"));
  await assertRejects(
    () => Promise.resolve(pending),
    Error,
    "cancelled source",
  );
});
