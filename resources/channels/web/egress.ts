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
        context.callback(event);
      }
    },
  };
}

export const webEgressAdapter = createWebEgressAdapter();

export default webEgressAdapter;
