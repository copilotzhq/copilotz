/**
 * A part's media, as it's sent: a public https link goes as it is. A chat's
 * file and a link to one of the app's routes aren't sent yet.
 */
import { type Context, invalid } from "../../../../runtime/mod.ts";
import type { Sendable } from "./graph.ts";
import type { WaMedia } from "./parts.ts";

export function sendable(_ctx: Context, media: WaMedia): Promise<Sendable> {
  if ("link" in media) return Promise.resolve({ link: media.link });
  return Promise.reject(invalid("WhatsApp: only public https links are sent as media yet."));
}
