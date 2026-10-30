/**
 * `whatsapp.hook`: a connected number's webhook (`/hooks/whatsapp/<number>`,
 * the web host's `routes` resource), as Meta calls it.
 *
 * - `GET`, when the webhook is set up: Meta shows the number's verify token
 *   and a challenge, which goes back as it came.
 * - `POST`: what people sent. Before anything else, the body's signature
 *   (`X-Hub-Signature-256`) is checked against the Meta app's secret; only a
 *   delivery Meta signed goes on. Each message it carries is recorded as
 *   `whatsapp.received`, by WhatsApp's id for it, so a delivery Meta sends
 *   again changes nothing; what happens next is the Processors' (see
 *   processors/receive.ts). One delivery may carry messages to several of
 *   the app's numbers, as long as they share its Meta app.
 *
 * Anyone may call it (it answers as a visitor); it reads the number's
 * credentials as the system, which it must to check anything. It isn't
 * recorded: what isn't signed leaves nothing in the log.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { WhatsAppNumber } from "../collections/number.ts";
import type { WhatsAppSecret } from "../collections/secret.ts";
import { bytesOf, type HttpAnswer, httpRequest } from "../shared/http.ts";
import { inboundOf } from "../shared/payload.ts";
import { same, signed } from "../shared/signature.ts";

/** Where each number's webhook is. */
export const HOOKS = "/hooks/whatsapp/";

const plain = (status: number, body: string): HttpAnswer => ({ status, body });

export const hookAction = defineAction({
  description: "WhatsApp's webhook for a connected number",
  input: httpRequest,
  record: false,
  allow: () => true,
  run: async (ctx, request): Promise<HttpAnswer> => {
    const id = request.path.startsWith(HOOKS)
      ? decodeURIComponent(request.path.slice(HOOKS.length)).replace(/\/$/, "")
      : "";
    const system = ctx.as();
    const secrets = system.db.collection<WhatsAppSecret>("whatsapp_secret");
    const own = id ? await secrets.findOne({ _id: id }) : null;
    if (!own) return plain(404, "No such number");

    if (request.method === "GET") {
      const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } =
        request.query;
      return mode === "subscribe" && token && challenge && same(token, own.verify)
        ? plain(200, challenge)
        : plain(403, "Forbidden");
    }
    if (request.method !== "POST") return plain(405, "POST or GET");
    if (!await signed(own.secret, bytesOf(request), request.headers["x-hub-signature-256"])) {
      return plain(401, "Bad signature");
    }

    // Signed by the Meta app: what it says is WhatsApp's.
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytesOf(request)));
    } catch {
      return plain(400, "Not JSON");
    }
    const inbound = inboundOf(payload);
    if (!inbound.length) return plain(200, "ok");
    const numbers = system.db.collection<WhatsAppNumber>("whatsapp_number");
    const found = await numbers.find({
      phoneId: { $in: [...new Set(inbound.map((m) => m.phoneId))] },
    });
    // A number of the same Meta app (the secret that signed it), this one first.
    const ours = new Map<string, string>();
    for (const n of found.sort((a, b) => Number(b._id === id) - Number(a._id === id))) {
      if (ours.has(n.phoneId)) continue;
      const theirs = n._id === id ? own : await secrets.findOne({ _id: n._id });
      if (theirs && same(theirs.secret, own.secret)) ours.set(n.phoneId, n._id);
    }
    const kept = inbound.filter((m) => ours.has(m.phoneId));
    if (kept.length) {
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
        return Promise.resolve();
      });
    }
    return plain(200, "ok");
  },
});
