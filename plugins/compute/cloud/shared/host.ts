/**
 * The cloud a placement is in: the `cloudHost` adapter the settings name
 * (`host`), made for the placement's account, once per account and runtime
 * (each with its own credentials: never one client for every account).
 */
import type { Context, ReadContext } from "../../../../runtime/mod.ts";
import { invalid } from "../../../../runtime/mod.ts";
import type { CloudHost, CloudHostAdapter, Placement } from "../contract.ts";
import { settingsOf } from "./settings.ts";

type Reach = Pick<Context | ReadContext, "resources" | "adapters">;

/** Hosts made, by adapter, then by the runtime's resources (one runtime each), then by account. */
const made = new WeakMap<object, WeakMap<object, Map<string, Promise<CloudHost>>>>();

/** The host for a placement's account. */
export function hostFor(ctx: Reach, placement: Placement): Promise<CloudHost> {
  const { host } = settingsOf(ctx);
  const adapter = (ctx.adapters.cloudHost ?? {})[host] as CloudHostAdapter | undefined;
  if (!adapter) {
    return Promise.reject(invalid(
      `No cloud host "${host}": add it to the adapters (adapters: { cloudHost: { ${host}: … } })`,
    ));
  }
  if (typeof adapter !== "function") return Promise.resolve(adapter);
  let runtimes = made.get(adapter);
  if (!runtimes) made.set(adapter, runtimes = new WeakMap());
  let accounts = runtimes.get(ctx.resources);
  if (!accounts) runtimes.set(ctx.resources, accounts = new Map());
  const account = placement.account ?? "";
  let found = accounts.get(account);
  if (!found) {
    found = Promise.resolve(adapter(placement.account, { resources: ctx.resources }));
    // One that couldn't be made is made again next time.
    found.catch(() => accounts!.delete(account));
    accounts.set(account, found);
  }
  return found;
}
