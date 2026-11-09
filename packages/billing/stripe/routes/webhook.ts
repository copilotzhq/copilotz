/**
 * Stripe's webhook, `POST /__stripe/<seller>`: the address each account's
 * dashboard sends its events to, one for every org, so it's the app's (in
 * an app of many orgs, the directory's runtime). The signature is checked
 * against that seller's secret, on the raw text; the event read as facts
 * (`stripe.fact`); and handed to its org's runtime as `billing.apply`, under
 * the event's own id, so an event sent twice answers from the org's log.
 *
 * Which runtime is the org's: the app's orgs (`stripe.orgs`, the directory's
 * `runtimes`), opened if it has to be; without them, this runtime, when the
 * event is for its org (`resources.org`). Anything that can be tried again
 * answers 500, and Stripe does; what never can (no such org, an event not
 * ours, a plan the app no longer has) answers 200.
 */
import type { Route } from "copilotz";
import type { Fact } from "../shared/events.ts";
import { verified } from "../shared/events.ts";
import { settingsOf } from "../shared/settings.ts";

const answer = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const webhookRoute: Route = async (request, { runtime, params }) => {
  if (request.method !== "POST") return answer(405, { error: "Only POST" });
  const resources = runtime.describe().resources;
  const settings = settingsOf({ resources });
  const name = decodeURIComponent(params.seller);
  const seller = Object.hasOwn(settings.sellers, name) ? settings.sellers[name] : undefined;
  if (!seller) return answer(404, { error: "No such seller" });
  const payload = await request.text();
  if (!await verified(seller.webhookSecret, payload, request.headers.get("stripe-signature"))) {
    return answer(400, { error: "Bad signature" });
  }
  let event: { id: string; type: string };
  try {
    event = JSON.parse(payload);
  } catch {
    return answer(400, { error: "Not JSON" });
  }
  try {
    const { fact } = await runtime.call<{ fact: Fact | null }>("stripe.fact", {
      seller: name,
      event,
    });
    // Not ours (another product on the account), or nothing to keep: received all the same.
    if (!fact) return answer(200, { ignored: event.type });
    const own = (resources.org as { id?: string } | undefined)?.id;
    const target = settings.orgs
      ? await settings.orgs.get(fact.org)
      : own === fact.org
      ? runtime
      : undefined;
    // An org that's gone won't come back, so there's nothing to try again.
    if (!target) return answer(200, { ignored: "no such org" });
    const { org: _, ...facts } = fact;
    await target.call("billing.apply", facts, { id: `stripe:${event.id}` });
    return answer(200);
  } catch (error) {
    console.error(
      `stripe: ${event.type} (${event.id}):`,
      error instanceof Error ? error.message : error,
    );
    // What can never land (a plan the app no longer has) isn't worth trying again.
    if ((error as { code?: string }).code === "invalid") {
      return answer(200, { ignored: "invalid" });
    }
    return answer(500, { error: "Try again" });
  }
};
