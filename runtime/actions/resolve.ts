import type { ProcessorContext } from "../plugins/index.ts";
import type { EventStore } from "../events/index.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import type { DeliveryContextBase } from "../execution/types.ts";
import { ACTION_RESOLVER_EVENT } from "./deferred-work.ts";
import { createActionLifecycleLoader } from "./persistence.ts";
import {
  type CreateActionCallersOptions,
  isSettledActionError,
} from "./invoker.ts";
import type { AnyActionDefinition } from "./types.ts";
import type { ProtectedValueRuntime } from "./protected-value.ts";
import { ActionOwnershipLost } from "./ownership.ts";

/** Only the runtime's leased resolver consumer may enter this path. */
export async function executeActionResolution(
  options: Readonly<{
    store: EventStore;
    actions: Readonly<Record<string, AnyActionDefinition>>;
    protectedValues?: ProtectedValueRuntime;
    base: DeliveryContextBase;
    createContext(
      base: DeliveryContextBase,
      resolution: CreateActionCallersOptions["resolution"],
    ): Promise<ProcessorContext>;
  }>,
): Promise<void> {
  const { store, base } = options;
  if (base.event.type !== ACTION_RESOLVER_EVENT) {
    throw new TypeError("Invalid Action resolution event.");
  }
  const raw = await readEventBody(
    { transaction: store.session, tables: store.tables },
    base.event.namespace,
    eventDataRef(base.event.payload),
  );
  const request = raw as {
    actionRunId?: unknown;
    actionId?: unknown;
    outcome?: unknown;
    error?: unknown;
  };
  if (
    !request || typeof request.actionRunId !== "string" ||
    typeof request.actionId !== "string" ||
    !["completed", "failed", "cancelled"].includes(String(request.outcome))
  ) {
    throw new TypeError("Invalid Action resolution request.");
  }
  const load = createActionLifecycleLoader(options);
  const owner = await store.session.query<
    { deferred_event_id: string; causation_id: string | null }
  >(
    `SELECT action.deferred_event_id, invoked.causation_id FROM ${store.tables.open_actions} AS action
     JOIN ${store.tables.events} AS invoked ON invoked.id = action.invoked_event_id
     WHERE action.namespace = $1 AND action.action_run_id = $2 AND action.state = 'resolving' AND action.owner_delivery_id = $3`,
    [base.event.namespace, request.actionRunId, base.delivery.id],
  );
  if (!owner.rows.length) {
    const terminal = await load(
      base.event.namespace,
      `${request.actionRunId}:action:terminal`,
    );
    if (terminal) return;
    throw new ActionOwnershipLost(request.actionRunId);
  }
  if (owner.rows[0].deferred_event_id !== base.event.causationId) {
    throw new TypeError("Action resolver does not own this handoff.");
  }
  const receipt = await load(
    base.event.namespace,
    `${request.actionRunId}:action:deferred`,
  );
  if (receipt?.status !== "deferred" || receipt.actionId !== request.actionId) {
    throw new Error("Action resolver cannot load its deferred receipt.");
  }
  const entry = Object.entries(options.actions).find(([, action]) =>
    action.id === receipt.actionId
  );
  if (!entry?.[1].resolve) {
    throw new Error(`Action '${receipt.actionId}' has no resolver.`);
  }
  const context = await options.createContext(base, {
    receipt,
    outcome: request.outcome as "completed" | "failed" | "cancelled",
    causationId: owner.rows[0].causation_id ?? undefined,
    ...(request.error
      ? { error: request.error as { name: string; message: string } }
      : {}),
  });
  try {
    await (context.actions[entry[0]] as (input: unknown) => Promise<unknown>)(
      receipt.input,
    );
  } catch (error) {
    // A durable Action failure is a semantic result; its terminal consumer now
    // owns continuation. Infrastructure failures still retry this delivery.
    if (!isSettledActionError(error)) throw error;
  }
}
