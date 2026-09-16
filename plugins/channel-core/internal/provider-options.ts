/** Provider capabilities are scoped to the current channel alias. @module */
import type { ChannelAcceptContext } from "./contracts.ts";
export function channelProviderOptions<T>(
  context: Pick<ChannelAcceptContext, "adapters" | "channelId">,
): T {
  const options = context.adapters?.channelProviders?.[context.channelId];
  if (
    !options || typeof options !== "object" || !("config" in options) ||
    !options.config
  ) {
    throw new TypeError(
      `Channel '${context.channelId}' requires config in adapters.channelProviders.`,
    );
  }
  return options as T;
}
