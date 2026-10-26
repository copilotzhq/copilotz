import { openProtectedEventBody } from "./protected-event.ts";
import type { ProcessorContext } from "../plugins/index.ts";
import type { EventStore } from "../events/index.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import type { DeliveryContextBase } from "../execution/types.ts";
import {
  ACTION_CHILD_EVENT,
  ACTION_RESUME_EVENT,
} from "./continuation-work.ts";
import { createActionLifecycleLoader } from "./persistence.ts";
import type { CreateActionCallersOptions } from "./invoker.ts";
import { isSettledActionError } from "./errors.ts";
import type { AnyActionDefinition } from "./types.ts";
import type { ProtectedValueRuntime } from "./protected-value.ts";
import { ActionOwnershipLost } from "./ownership.ts";

/** Only the runtime's leased resumption consumer may enter this path. */
export async function executeActionContinuation(
  options: Readonly<{
    store: EventStore;
    actions: Readonly<Record<string, AnyActionDefinition>>;
    protectedValues?: ProtectedValueRuntime;
    base: DeliveryContextBase;
    createContext(
      base: DeliveryContextBase,
      resumption: CreateActionCallersOptions["resumption"],
    ): Promise<ProcessorContext>;
  }>,
): Promise<void> {
  const { store, base } = options;
  const raw = await readEventBody(
    { transaction: store.session, tables: store.tables },
    base.event.namespace,
    eventDataRef(base.event.payload),
  );
  if (base.event.type === ACTION_CHILD_EVENT) {
    const request = await openProtectedEventBody({
      namespace: base.event.namespace,
      body: raw,
      protectedValues: options.protectedValues,
    }) as { action: string; input: unknown; metadata: Record<string, unknown> };
    const context = await options.createContext(base, undefined);
    const caller = context.actions[request.action] as (
      input: unknown,
      options: import("./types.ts").ActionCallOptions,
    ) => Promise<unknown>;
    if (!caller) {
      throw new TypeError(`Unknown child Action '${request.action}'.`);
    }
    try {
      await caller(request.input as never, { metadata: request.metadata });
    } catch (error) {
      if (!isSettledActionError(error)) throw error;
    }
    return;
  }
  if (base.event.type !== ACTION_RESUME_EVENT) {
    throw new TypeError("Invalid continuation event.");
  }
  const request = raw as {
    actionRunId: string;
    actionId: string;
    outcome: import("./continuation.ts").OperationOutcome;
  };
  if (
    !request || typeof request.actionRunId !== "string" ||
    typeof request.actionId !== "string" ||
    !["completed", "failed", "cancelled"].includes(request.outcome?.status)
  ) throw new TypeError("Invalid resumption request.");
  const load = createActionLifecycleLoader(options);
  const owner = await store.session.query<
    {
      await_event_id: string;
      causation_id: string | null;
    }
  >(
    `SELECT action.await_event_id, invoked.causation_id FROM ${store.tables.open_actions} AS action
     JOIN ${store.tables.events} AS invoked ON invoked.id = action.invoked_event_id
     WHERE action.namespace = $1 AND action.action_run_id = $2 AND action.state = 'awaiting' AND action.owner_delivery_id = $3`,
    [
      base.event.namespace,
      request.actionRunId,
      base.delivery.id,
    ],
  );
  if (!owner.rows.length) {
    const terminal = await load(
      base.event.namespace,
      `${request.actionRunId}:action:terminal`,
    );
    if (terminal) return;
    throw new ActionOwnershipLost(request.actionRunId);
  }
  if (owner.rows[0].await_event_id !== base.event.causationId) {
    throw new TypeError("Action resumption does not own this handoff.");
  }
  const receipt = await load(
    base.event.namespace,
    `${request.actionRunId}:action:awaiting`,
  );
  if (receipt?.status !== "awaiting" || receipt.actionId !== request.actionId) {
    throw new Error("Action resumption cannot load its awaiting receipt.");
  }
  const entry = Object.entries(options.actions).find(([, action]) =>
    action.id === receipt.actionId
  );
  if (!entry?.[1].resume) {
    throw new Error(`Action '${receipt.actionId}' has no resumption.`);
  }
  const context = await options.createContext(base, {
    receipt,
    outcome: request.outcome,
    causationId: owner.rows[0].causation_id ?? undefined,
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
