/**
 * What the webhook (`routes/hook.ts`) asks of the plugin, as plain data; only
 * trusted code calls them (no `allow`), and neither is recorded: what isn't
 * signed leaves nothing in the log.
 *
 * - `whatsapp.line`: which line a webhook path is, and what checks Meta's
 *   call to it: its verify token and the Meta app's secret. A line the app
 *   declares, at the path it chose (`/hooks/whatsapp/<name>` unless it says
 *   another); else a number connected here, at `/hooks/whatsapp/<number>`.
 *   Null when the path is neither.
 * - `whatsapp.receive`: a delivery Meta signed (the route checked it). Each
 *   message it carries is recorded as `whatsapp.received`, by WhatsApp's id
 *   for it, so a delivery Meta sends again changes nothing; what happens
 *   next is the Processors' (see processors/receive.ts). So is each failed
 *   status of what was sent (`whatsapp.undelivered`: see processors/reply.ts).
 *   One delivery may carry messages to several of the app's numbers, as long
 *   as they share its Meta app.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import type { WhatsAppNumber } from "../collections/number.ts";
import type { WhatsAppSecret } from "../collections/secret.ts";
import { inboundOf, undeliveredOf } from "../shared/payload.ts";
import { connected } from "../shared/number.ts";
import { linesOf } from "../shared/settings.ts";
import { same } from "../shared/signature.ts";

/** Where each number's webhook is. */
export const HOOKS = "/hooks/whatsapp/";

/** A line's name and what checks Meta's calls to it. */
export type HookLine = { line: string; verify: string; secret: string };

export const lineAction = defineAction({
  description: "Which line a webhook path is, and what checks Meta's calls to it",
  input: {
    type: "object",
    properties: { path: { type: "string", maxLength: 1000 } },
    required: ["path"],
    additionalProperties: false,
  },
  record: false,
  run: async (ctx, input): Promise<HookLine | null> => {
    const lines = linesOf(ctx);
    const path = input.path.replace(/\/$/, "");
    const declared = Object.entries(lines)
      .find(([name, line]) => (line.path ?? `${HOOKS}${name}`).replace(/\/$/, "") === path)?.[0];
    if (declared) {
      const { verify, secret } = lines[declared];
      return { line: declared, verify, secret };
    }
    let id = "";
    try {
      id = path.startsWith(HOOKS) ? decodeURIComponent(path.slice(HOOKS.length)) : "";
    } catch {
      // A malformed id names no number.
    }
    // A declared line is reached at its own path alone.
    if (!id || Object.hasOwn(lines, id)) return null;
    const own = await ctx.as().db.collection<WhatsAppSecret>("whatsapp_secret").findOne({
      _id: id,
    });
    return own ? { line: id, verify: own.verify, secret: own.secret } : null;
  },
});

/** The line's credentials: the app's own line, or a connected number's. */
async function credentials(ctx: Context, line: string) {
  const lines = linesOf(ctx);
  if (Object.hasOwn(lines, line)) return { declared: true, own: lines[line] };
  const own = await ctx.as().db.collection<WhatsAppSecret>("whatsapp_secret").findOne({
    _id: line,
  });
  return { declared: false, own };
}

export const receiveAction = defineAction({
  description: "A delivery from Meta to a line's webhook, signed: what people sent",
  input: {
    type: "object",
    properties: { line: { type: "string" }, payload: { type: "object" } },
    required: ["line", "payload"],
    additionalProperties: false,
  },
  record: false,
  run: async (ctx, input) => {
    const id = input.line;
    const { declared, own } = await credentials(ctx, id);
    if (!own) return;
    const system = ctx.as();
    const secrets = system.db.collection<WhatsAppSecret>("whatsapp_secret");
    // Signed by the Meta app: what it says is WhatsApp's. A declared line is kept as the app says.
    if (declared) await connected(ctx, id);
    const payload = input.payload;
    const inbound = inboundOf(payload);
    const failed = undeliveredOf(payload);
    if (!inbound.length && !failed.length) return;
    const numbers = system.db.collection<WhatsAppNumber>("whatsapp_number");
    const found = await numbers.find({
      phoneId: { $in: [...new Set([...inbound, ...failed].map((m) => m.phoneId))] },
    });
    // A number of the same Meta app (the secret that signed it), this one first.
    const ours = new Map<string, string>();
    for (const n of found.sort((a, b) => Number(b._id === id) - Number(a._id === id))) {
      if (ours.has(n.phoneId)) continue;
      const theirs = n._id === id ? own : await secrets.findOne({ _id: n._id });
      if (theirs && same(theirs.secret, own.secret)) ours.set(n.phoneId, n._id);
    }
    const kept = inbound.filter((m) => ours.has(m.phoneId));
    const lost = failed.filter((m) => ours.has(m.phoneId));
    if (!kept.length && !lost.length) return;
    // One commit for them all.
    await ctx.transaction((tx) => {
      for (const { phoneId, message, name } of kept) {
        const number = ours.get(phoneId)!;
        tx.emit(
          "whatsapp.received",
          { number, from: message.from, ...(name ? { name } : {}), message },
          { id: `whatsapp:${number}:${message.id}` },
        );
      }
      for (const { phoneId, wamid, to, errors } of lost) {
        const number = ours.get(phoneId)!;
        tx.emit(
          "whatsapp.undelivered",
          { number, wamid, to, ...(errors ? { errors } : {}) },
          { id: `whatsapp:${number}:${wamid}:failed` },
        );
      }
      return Promise.resolve();
    });
  },
});
