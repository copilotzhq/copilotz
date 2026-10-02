import { assertEquals, assertRejects } from "@std/assert";
import {
  transcribeGemini,
  transcribeOpenAi,
  type TranscriptionHttpInput,
} from "./http.ts";
const input: TranscriptionHttpInput = {
  bytes: new Uint8Array([1, 2, 3]),
  mimeType: "audio/webm",
  filename: "voice.webm",
  model: "gpt-transcribe",
  apiKey: "test",
};
Deno.test("OpenAI sends identified prerecorded file and language options", async () => {
  const result = await transcribeOpenAi(
    { ...input, languageCodes: ["pt"] },
    ((_url, init) => {
      const form = init?.body as FormData;
      assertEquals(form.get("model"), "gpt-transcribe");
      assertEquals(form.get("languages[]"), "pt");
      const file = form.get("file") as File;
      assertEquals(file.name, "voice.webm");
      assertEquals(file.type, "audio/webm");
      return Promise.resolve(Response.json({ text: "Não envie 42." }));
    }) as typeof fetch,
  );
  assertEquals(result.text, "Não envie 42.");
});
Deno.test("Gemini is stateless and only parses completed model output", async () => {
  const result = await transcribeGemini(
    { ...input, model: "gemini-3.5-transcribe" },
    ((_url, init) => {
      const body = JSON.parse(init?.body as string);
      assertEquals(body.store, false);
      assertEquals(body.input[0].data, "AQID");
      assertEquals(
        body.generation_config.transcription_config.mode,
        { type: "verbatim" },
      );
      return Promise.resolve(Response.json({
        status: "completed",
        steps: [
          { type: "thought", content: [{ type: "text", text: "hidden" }] },
          { type: "user_input", content: [{ type: "text", text: "input" }] },
          {
            type: "model_output",
            content: [{ type: "text", text: "Do not send 42." }],
          },
        ],
      }));
    }) as typeof fetch,
  );
  assertEquals(result.text, "Do not send 42.");
});
Deno.test("Gemini rejects incomplete and empty output", async () => {
  await assertRejects(() =>
    transcribeGemini(
      input,
      (() =>
        Promise.resolve(
          Response.json({ status: "incomplete", steps: [] }),
        )) as typeof fetch,
    )
  );
});
Deno.test("Provider error does not leak response body", async () => {
  await assertRejects(
    () =>
      transcribeOpenAi(
        input,
        (() =>
          Promise.resolve(
            new Response("private recording", { status: 401 }),
          )) as typeof fetch,
      ),
    Error,
    "HTTP 401",
  );
});
Deno.test("Empty audio fails before network", async () => {
  await assertRejects(
    () =>
      transcribeOpenAi(
        { ...input, bytes: new Uint8Array() },
        (() => {
          throw Error("network must not run");
        }) as typeof fetch,
      ),
    Error,
    "bytes",
  );
});
Deno.test("HTTP helper abort cancels stalled response body after headers", async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      entered();
    },
    cancel() {
      cancelled = true;
    },
  });
  const pending = transcribeOpenAi(
    { ...input, signal: controller.signal },
    (() => Promise.resolve(new Response(body))) as typeof fetch,
  );
  await started;
  controller.abort(new Error("cancelled response"));
  await assertRejects(() => pending, Error, "cancelled response");
  assertEquals(cancelled, true);
});
