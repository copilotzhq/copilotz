/**
 * Where an agent's work may go, and what it drew on, on the record.
 *
 * - **The bound.** Work done for someone (an agent's, a routine's) reads only
 *   what both its destination and its asker reach (reach.ts): a space and
 *   what it draws on, a conversation shared on its own with a contact and
 *   what its space lets contacts read, or, in its person's own Personal
 *   space, all they reach. Its answer there needs nothing more: everyone it's
 *   shown to could see what it read.
 * - **Going wider is a share.** What it writes anywhere whose readers don't
 *   all reach its bound (a Personal space's agent posting in Launch, a team's
 *   answering into a contact's chat) is refused (`needs_approval`) until its
 *   person says yes to that place (`approved` on the actor: the turn sets it
 *   from their answer). Nothing is ever hidden once written.
 * - **Elevating, in front of a contact.** Trusted code going beyond its
 *   caller (`ctx.as()`) in an Action's job, for an agent answering in a
 *   conversation shared with a contact, goes on only if that Action lets a
 *   contact call it (its `allow`): the tools an app offers there are its own
 *   choice, and run as they are.
 * - **On the record.** A document an agent writes in a collection that keeps
 *   it (`shared: { message: { drew: true } }`) says which other spaces its
 *   job read (`drew`), for whoever moves its conversation (chat.move): never
 *   a gate, and only spaces its own readers reach (what an approved share
 *   drew on beyond them isn't theirs to learn; trusted code's own reads, as
 *   the system, are never counted).
 */
import type { Actor, Labels, ReadContext } from "../../../../runtime/mod.ts";
import { whereOf } from "../../../../runtime/mod.ts";
import { audienceOf, covers } from "./audience.ts";
import { CHAT, coverOf, docKey, narrows, sharedWith } from "./reach.ts";
import type { Shared } from "./rules.ts";

/** The `shared` resource; an entry is a collection's own key, never what objects inherit. */
const sharedOf = (ctx: ReadContext) => (ctx.resources.shared ?? {}) as Shared;
const entryOf = (shared: Shared, collection: string) =>
  Object.hasOwn(shared, collection) ? shared[collection] : undefined;

/**
 * Where a document written in `space` is shown: the conversation it's part
 * of (a message's chat) or is, when that's shared on its own with someone
 * outside its space; else its space.
 */
async function destinationOf(
  collection: string,
  doc: Record<string, unknown>,
  space: string,
  shared: Shared,
  ctx: ReadContext,
): Promise<string> {
  const part = entryOf(shared, collection)?.part;
  const whole = part
    ? typeof doc[part] === "string" ? docKey(part, doc[part] as string) : undefined
    : collection === CHAT && typeof doc._id === "string"
    ? docKey(CHAT, doc._id)
    : undefined;
  return whole && (await sharedWith(whole, ctx)).length ? whole : space;
}

/** The most of a document a share's ask shows of it. */
const PREVIEW = 280;

/** What a document says, shortly, for whoever is asked to share it: its text, else its title or name. */
function previewOf(doc: Record<string, unknown>): string | undefined {
  const said = [doc.text, doc.title, doc.name].find((v) => typeof v === "string" && v.trim());
  if (typeof said !== "string") return undefined;
  const text = said.trim();
  return text.length > PREVIEW ? `${text.slice(0, PREVIEW - 1).trimEnd()}…` : text;
}

/**
 * The refusal of a share, saying what its person is asked about: where it
 * would show (`to`), as people say it (`named`), and what it would say
 * (`preview`); its `detail`, so that reaches the turn that asks them.
 */
const needsApproval = (to: string, named: string, preview?: string) => {
  const detail = { to, named, ...(preview ? { preview } : {}) };
  return Object.assign(
    new Error(
      `That would show ${named} what this conversation may draw on, and not everyone there can ` +
        "see it: the person this is done for has to say yes first.",
    ),
    { code: "needs_approval", ...detail, detail },
  );
};

/** Whether a place was approved for this work (`approved`, set by its turn from a yes). */
const approved = (actor: Actor, target: string, space: string) =>
  Array.isArray(actor.approved) &&
  (actor.approved.includes(target) || actor.approved.includes(space));

export const labels: Labels = {
  read(collection, docs, ctx) {
    const shared = entryOf(sharedOf(ctx), collection);
    // A document that's a member (an agent) is meant for everywhere it works: it says nothing.
    if (!shared || shared.member) return [];
    const field = shared.field ?? "in";
    return docs.flatMap((doc) => [
      ...(typeof doc[field] === "string" ? [doc[field] as string] : []),
      ...(Array.isArray(doc.drew) ? doc.drew as string[] : []),
    ]);
  },
  async write(actor, collection, doc, read, ctx) {
    const all = sharedOf(ctx);
    const shared = entryOf(all, collection);
    if (!shared || shared.member) return doc;
    const space = doc[shared.field ?? "in"];
    if (typeof space !== "string") return doc;
    // What everyone it's shown to reaches: checked, and all its record may say.
    let cover: Set<string> | undefined;
    if (narrows(actor) && whereOf(actor) !== undefined) {
      const target = await destinationOf(collection, doc, space, all, ctx);
      cover = await coverOf(target, ctx);
      if (!approved(actor, target, space) && !await covers(actor, cover, ctx)) {
        throw needsApproval(target, (await audienceOf(target, ctx)).named, previewOf(doc));
      }
    }
    if (!shared.drew || actor.kind !== "agent") return doc;
    const drew = [
      ...new Set([...(Array.isArray(doc.drew) ? doc.drew as string[] : []), ...read]),
    ].filter((one) => one !== space && (!cover || cover.has(one))).sort();
    return drew.length ? { ...doc, drew } : doc;
  },
  async elevate(actor, allow, ctx) {
    if (actor.kind !== "agent" || typeof actor.thread !== "string") return true;
    const outside = await sharedWith(docKey(CHAT, actor.thread), ctx);
    if (!outside.some((member) => member.startsWith("contact:"))) return true;
    // An Action of the app's own (no `allow`) is what its tool chose to do; one people call is
    // let in only if a contact could call it themselves.
    return !allow || allow({ kind: "contact", id: "" }, undefined);
  },
};
