/**
 * `computer.connected`: which plans the person a call is for has signed in
 * on a computer of theirs, for the models plugin's `connectedPlans`
 * resource: the providers whose engine (`options.engine`) is signed in there
 * as it last said, on one that's on or that wakes when asked (a cloud
 * computer). A laptop that's off doesn't count until it's on, and none does
 * while nobody's there (a routine): a plan's CLI runs only for its person,
 * present. A stale answer costs a call one fast failure: the engine checks
 * again (shared/engines.ts). Whose: the person acting, or the person an agent
 * works for. For trusted code only, and unrecorded.
 *
 * A plan whose CLI listed the models it runs (Antigravity, Grok Build,
 * Cursor) is `{ plan, models }`, with those it listed on any of those
 * computers; the others are their provider's name.
 */
import { defineAction, personOf } from "../../../../runtime/mod.ts";
import { originOf } from "../../../agents/chat/contract.ts";
import type { PlansConnected, Provider } from "../../../models/contract.ts";
import type { Computer } from "../collections/computer.ts";
import type { EngineSeen } from "../shared/engines.ts";

export const connectedAction = defineAction({
  description:
    "The plans the person a call is for has signed in on their computers (trusted code only)",
  record: false,
  run: async (ctx): Promise<PlansConnected> => {
    const person = personOf(ctx.actor);
    if (!person || originOf(ctx.actor)) return [];
    const computers = await ctx.as().db.collection<Computer>("computer")
      .find({ owner: person }, { projection: { online: 1, status: 1, engines: 1 } });
    // Each engine signed in there, with the models it listed on any of them.
    const signed = new Map<string, string[]>();
    for (const computer of computers.filter((c) => c.online || c.status)) {
      for (
        const [engine, seen] of Object.entries(
          (computer.engines ?? {}) as Record<string, EngineSeen>,
        )
      ) {
        if (seen?.signedIn) {
          signed.set(engine, [...new Set([...signed.get(engine) ?? [], ...seen.models ?? []])]);
        }
      }
    }
    return Object.entries((ctx.resources.provider ?? {}) as Record<string, Provider | null>)
      .filter(([, p]) => p?.adapter === "engine" && signed.has(String(p.options?.engine)))
      .map(([name, p]) => {
        const models = signed.get(String(p!.options?.engine))!;
        return models.length ? { plan: name, models } : name;
      });
  },
});
