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
 */
import { defineAction, personOf } from "../../../../runtime/mod.ts";
import { originOf } from "../../../agents/chat/contract.ts";
import type { Provider } from "../../../models/contract.ts";
import type { Computer } from "../collections/computer.ts";
import type { EngineSeen } from "../shared/engines.ts";

export const connectedAction = defineAction({
  description:
    "The plans the person a call is for has signed in on their computers (trusted code only)",
  record: false,
  run: async (ctx): Promise<string[]> => {
    const person = personOf(ctx.actor);
    if (!person || originOf(ctx.actor)) return [];
    const computers = await ctx.as().db.collection<Computer>("computer")
      .find({ owner: person }, { projection: { online: 1, status: 1, engines: 1 } });
    const signed = new Set(
      computers.filter((c) => c.online || c.status).flatMap((c) =>
        Object.entries((c.engines ?? {}) as Record<string, EngineSeen>)
          .filter(([, seen]) => seen?.signedIn).map(([engine]) => engine)
      ),
    );
    return Object.entries((ctx.resources.provider ?? {}) as Record<string, Provider | null>)
      .filter(([, p]) => p?.adapter === "engine" && signed.has(String(p.options?.engine)))
      .map(([name]) => name);
  },
});
