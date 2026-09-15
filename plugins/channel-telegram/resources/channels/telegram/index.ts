/** Default channel policy; override the resource at root composition. @module */
import type { ChannelResource } from "../../../../channel-core/internal/contracts.ts";
export const telegramChannelResource: ChannelResource = { egress: "external" };

export default telegramChannelResource;
