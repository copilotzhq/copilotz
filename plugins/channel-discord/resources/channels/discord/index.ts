/** Default channel policy; override the resource at root composition. @module */
import type { ChannelResource } from "@copilotz/copilotz/channels/core";
export const discordChannelResource: ChannelResource = { egress: "external" };

export default discordChannelResource;
