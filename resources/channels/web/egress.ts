import type { EgressAdapter } from "@/server/channels.ts";
import { toAsyncIterable } from "@/server/channels.ts";

export function createWebEgressAdapter(): EgressAdapter {
  return {
    requestBound: true,
    requiresCallback: true,
    async deliver(context) {
      if (!context.callback) {
        throw {
          status: 400,
          message: "Web egress requires a callback for streaming",
        };
      }

      for await (const event of toAsyncIterable(context.handle.events)) {
        // The web UI renders live output from TOKEN/LLM_RESULT and refreshes
        // persisted history separately. Forwarding the native persistence
        // event would render the same assistant message a second time.
        if (
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "message.created"
        ) {
          continue;
        }
        context.callback(event);
      }
    },
  };
}

export const webEgressAdapter = createWebEgressAdapter();

export default webEgressAdapter;
