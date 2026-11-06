/**
 * A connected number's webhook (`/hooks/whatsapp/<number>`), as Meta calls
 * it; or a number the app declares, at `/hooks/whatsapp/<name>` or the path
 * the app routes here (`routes: { "/webhooks/meta": hookRoute }`).
 *
 * - `GET`, when the webhook is set up: Meta shows the number's verify token
 *   and a challenge, which goes back as it came.
 * - `POST`: what people sent. Before anything else, the body's signature
 *   (`X-Hub-Signature-256`) is checked against the Meta app's secret; only a
 *   delivery Meta signed goes on, as plain data to `whatsapp.receive`.
 *
 * Anyone may call it; it reads the number's credentials as the system, which
 * it must to check anything.
 */
import { bodyOf, type Route } from "../../../../runtime/mod.ts";
import type { HookNumber } from "../actions/hook.ts";
import { same, signed } from "../shared/signature.ts";

/** The largest delivery it reads. */
const MOST = 4 * 1024 * 1024;

const plain = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export const hookRoute: Route = async (request, { runtime }) => {
  const url = new URL(request.url);
  const own = await runtime.call<HookNumber | null>("whatsapp.number", { path: url.pathname });
  if (!own) return plain(404, "No such number");

  if (request.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    return mode === "subscribe" && token && challenge && same(token, own.verify)
      ? plain(200, challenge)
      : plain(403, "Forbidden");
  }
  if (request.method !== "POST") return plain(405, "POST or GET");
  const bytes = await bodyOf(request, MOST);
  if (!bytes) return plain(413, "Too large");
  if (!await signed(own.secret, bytes, request.headers.get("x-hub-signature-256") ?? undefined)) {
    return plain(401, "Bad signature");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return plain(400, "Not JSON");
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    await runtime.call("whatsapp.receive", { number: own.number, payload });
  }
  return plain(200, "ok");
};
