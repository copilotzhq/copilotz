import { createLlmAdapter } from "@copilotz/copilotz/llm";
import { assertBrowserWorker } from "../../../shared/browser.ts";
import { decide } from "./protocol.ts";
/** Deterministic acceptance model, not a real provider integration. */
export default createLlmAdapter({
  call(input) {
    assertBrowserWorker();
    const result = decide(input);
    return {
      frames: new ReadableStream({
        start(controller) {
          if (typeof result.content === "string") {
            controller.enqueue({
              lane: "content",
              mediaType: "text/plain",
              bytes: new TextEncoder().encode(result.content),
            });
          }
          controller.close();
        },
      }),
      result: Promise.resolve(result),
    };
  },
});
