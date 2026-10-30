/**
 * The pool's Actions, forwarded (`remotePool`): for a runtime whose cloud
 * computers' pool is another runtime's (an app of many orgs: each org's
 * runtime, the pool in the directory's). Each forwards its input as it is,
 * with the org it's for (`org`), so the pool gives and touches only that
 * org's VMs. Run as the system, like the pool's own.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { POOL_ACTIONS } from "../contract.ts";

/** How a runtime reaches the pool's: an Action of it, by name, with its input. */
export type PoolCall = (action: string, input: Record<string, unknown>) => Promise<unknown>;

/** The forwarding Actions, by name: `pool.take`, `pool.serve`, `pool.stop`, `pool.drop`, `pool.renew`. */
export function remoteActions(call: PoolCall, org?: string) {
  const forward = (action: string, record = true) =>
    defineAction({
      ...(record ? {} : { record: false }),
      input: { type: "object" },
      run: (_ctx, input) =>
        call(action, org !== undefined ? { ...input as Record<string, unknown>, org } : input),
    });
  return {
    [POOL_ACTIONS.take]: forward(POOL_ACTIONS.take),
    [POOL_ACTIONS.serve]: forward(POOL_ACTIONS.serve),
    [POOL_ACTIONS.stop]: forward(POOL_ACTIONS.stop),
    [POOL_ACTIONS.drop]: forward(POOL_ACTIONS.drop),
    [POOL_ACTIONS.renew]: forward(POOL_ACTIONS.renew, false),
  };
}
