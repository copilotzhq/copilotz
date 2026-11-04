/**
 * A part's media, as it's sent. Views stay pure and hold no secrets: what a
 * View names (`WaMedia`) becomes something Meta fetches only here, as it
 * goes out.
 *
 * - **A public https link** goes as it is.
 * - **One of the app's routes** (`{ route, params }`: a picture it draws on
 *   demand, a trip's card) goes as a link signed for an hour, its params in
 *   it; the route checks it with the runtime's `verifyLink`.
 * - **A chat's file** (`{ file }`), one its recipient may read, goes as a
 *   link signed for an hour, which the web host serves without a session,
 *   when the app says where it is (the `links` resource); without, it's
 *   uploaded to Meta and sent by its id (not kept: Meta's ids expire).
 * - **A carousel's pictures** must be links (Meta takes no uploaded one
 *   there): a file there, with nowhere to link it, can't go (`unsendable`),
 *   and the addition's fallback goes instead.
 */
import {
  type Actor,
  type Context,
  failure,
  invalid,
  linksOf,
  signLink,
} from "../../../../runtime/mod.ts";
import type { File } from "../../../agents/chat/contract.ts";
import { type Graph, type Sendable, uploadMedia } from "./graph.ts";
import type { WaMedia } from "./parts.ts";

type Routes = Record<string, { path?: string } | null>;

export async function sendable(
  ctx: Context,
  graph: Graph,
  media: WaMedia,
  /** Whom it goes to: a chat's file goes only when they may read it. */
  reader: Actor | undefined,
  linked = false,
): Promise<Sendable> {
  if ("link" in media) return { link: media.link };
  const links = linksOf(ctx.resources);
  if ("route" in media) {
    const path = ((ctx.resources.routes ?? {}) as Routes)[media.route]?.path;
    if (!path) throw invalid(`WhatsApp: no route "${media.route}" to link to.`);
    if (!links) throw invalid("WhatsApp: a route's link needs the app's `links` resource.");
    return { link: await signLink(links, path, media.params) };
  }
  // Read as whom it goes to: a file they may not see is neither linked nor uploaded.
  const file = await (reader ? ctx.as(reader) : ctx.as()).db.collection<File>("file")
    .findOne({ _id: media.file });
  if (!file) throw failure("unsendable", `WhatsApp: no file "${media.file}" theirs to see.`);
  if (links) return { link: await signLink(links, `/files/${encodeURIComponent(media.file)}`) };
  if (linked) {
    throw failure(
      "unsendable",
      "WhatsApp: a carousel's picture is a link, and the app has no `links` to link a file.",
    );
  }
  const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
  return { id: await uploadMedia(graph, { bytes, type: file.type, name: file.name }) };
}
