import type { LlmAdapter } from "@copilotz/copilotz/llm";
// Deterministic provider for the runnable tutorial. No API key or network call.
const demo: LlmAdapter = {
  call: () => ({
    frames: new ReadableStream({
      start(controller) {
        controller.enqueue({
          lane: "content",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode(
            "Hello from the generated support plugin.",
          ),
        });
        controller.close();
      },
    }),
    result: Promise.resolve({
      content: "Hello from the generated support plugin.",
      attempts: [{ status: "completed" }],
    }),
  }),
};
export default demo;
