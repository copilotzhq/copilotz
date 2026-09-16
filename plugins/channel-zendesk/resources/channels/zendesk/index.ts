/** Default channel policy; override the resource at root composition. @module */
import type { ChannelResource } from "../../../../channel-core/internal/contracts.ts";
export const zendeskChannelResource: ChannelResource = { egress: "external" };

export default zendeskChannelResource;
