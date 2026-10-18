import {
  ActionOwnershipLost,
  actionOwnershipStatement,
  type ActionWriter,
  combineActionStatements,
  validateOwnerActionAuthority,
} from "./ownership.ts";
import type { SqlExecutor } from "../events/session.ts";
import type { OwnerEventCommitContext } from "../events/store.ts";
import {
  composeActionInputRetention,
  planActionInputRetention,
  retainActionInputContent,
} from "./content-retention.ts";
import type { EventCoordinator } from "../events/index.ts";
import type { DurableEvent, EventStore } from "../events/index.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import { withProcessorEventData } from "../plugins/processor.ts";
import { parseActionLifecycleEvent } from "./event.ts";
import {
  actionDefinitionById,
  actionDefinitionHasSecrets,
  actionInputHasSecrets,
  hydrateActionLifecycleBody,
  prepareActionLifecycleBody,
  protectedActionLifecycleBody,
  publicActionLifecycleData,
  samePreparedActionLifecycleBody,
} from "./protected-lifecycle.ts";
import type { ProtectedValueRuntime } from "./protected-value.ts";
import type {
  ActionEventData,
  ActionLifecycleAppender,
  ActionLifecycleLoader,
  AnyActionDefinition,
} from "./types.ts";

type LifecycleStore = Pick<
  EventStore,
  "getEventByDeduplicationId" | "session" | "tables"
>;

type ActionLifecyclePersistenceOptions = Readonly<{
  store?: LifecycleStore;
  actions?: Readonly<Record<string, AnyActionDefinition>>;
  protectedValues?: ProtectedValueRuntime;
  writer?: ActionWriter;
  transaction?: SqlExecutor;
  /** Explicit owner-controlled command authority; never taken from lifecycle data. */
  ownerAuthority?: OwnerEventCommitContext;
  /** Required for owner-attempt writers and checked against the actual tables. */
  schema?: string;
}>;

async function rawEventBody(
  store: Pick<EventStore, "session" | "tables">,
  event: DurableEvent,
): Promise<unknown> {
  return await readEventBody(
    { transaction: store.session, tables: store.tables },
    event.namespace,
    eventDataRef(event.payload),
  );
}

async function invokedInputRef(
  options: ActionLifecyclePersistenceOptions,
  namespace: string,
  data: ActionEventData,
) {
  if (data.status === "invoked" || !options.store) return undefined;
  const deduplicationId = `${data.actionRunId}:action:invoked`;
  const executor = options.transaction ?? options.store.session;
  const receipt = options.transaction
    ? (await executor.query<{ payload: unknown }>(
      `SELECT payload FROM ${options.store.tables.events} WHERE namespace = $1 AND deduplication_id = $2`,
      [namespace, deduplicationId],
    )).rows[0]
    : await options.store.getEventByDeduplicationId(namespace, deduplicationId);
  if (!receipt) {
    throw new Error(
      `Protected Action invoked receipt '${data.actionRunId}' is missing.`,
    );
  }
  const body = protectedActionLifecycleBody(
    await readEventBody(
      { transaction: executor, tables: options.store.tables },
      namespace,
      eventDataRef(receipt.payload),
    ),
  );
  return body?.protected.input;
}

export function createActionLifecycleAppender(
  options:
    & Readonly<{
      coordinator: EventCoordinator;
      /** Trusted owner-boundary clock for delivery authority; defaults to SQL NOW(). */
      commandTime?: string;
    }>
    & ActionLifecyclePersistenceOptions,
): ActionLifecycleAppender {
  // Preparation may await protected storage. Caller-owned mutable references
  // must not change the authority, transaction or table binding across it.
  const commitMutation = options.coordinator.commitMutation.bind(
    options.coordinator,
  );
  const protectedValues = options.protectedValues
    ? {
      prepare: options.protectedValues.prepare.bind(options.protectedValues),
      adopt: options.protectedValues.adopt.bind(options.protectedValues),
      open: options.protectedValues.open.bind(options.protectedValues),
      project: options.protectedValues.project.bind(options.protectedValues),
    }
    : undefined;
  const ownerAuthority = options.ownerAuthority
    ? {
      ...options.ownerAuthority,
      ownerAttempt: options.ownerAuthority.ownerAttempt
        ? { ...options.ownerAuthority.ownerAttempt }
        : undefined,
    }
    : undefined;
  options = {
    ...options,
    writer: options.writer ? { ...options.writer } : undefined,
    ownerAuthority,
    protectedValues,
    store: options.store
      ? { ...options.store, tables: { ...options.store.tables } }
      : undefined,
  };
  const attemptOwner = options.writer?.kind === "owner-attempt"
    ? { authority: ownerAuthority!, schema: options.schema! }
    : undefined;
  if (options.writer?.kind === "owner-attempt") {
    if (
      !options.store || !ownerAuthority || !options.transaction ||
      options.transaction !== ownerAuthority.transaction
    ) {
      throw new TypeError(
        "Owner-controlled Actions require a store, authority and matching command transaction.",
      );
    }
    validateOwnerActionAuthority(
      options.writer,
      attemptOwner,
      options.store.tables,
    );
    if (
      options.commandTime !== undefined &&
      options.commandTime !== ownerAuthority.commandTime
    ) {
      throw new TypeError(
        "Owner-controlled Action command timestamps must match.",
      );
    }
  }
  const commandTime = options.commandTime !== undefined
    ? options.commandTime
    : attemptOwner?.authority.commandTime;
  if (
    commandTime !== undefined &&
    (typeof commandTime !== "string" ||
      !Number.isFinite(Date.parse(commandTime)))
  ) {
    throw new TypeError("Action commandTime must be a valid timestamp.");
  }
  return async ({ draft, data }) => {
    if (attemptOwner) {
      const expected = attemptOwner.authority.ownerAttempt!;
      if (
        draft.deliveryLease && (
          draft.deliveryLease.deliveryId !== expected.deliveryId ||
          draft.deliveryLease.owner !== expected.attemptId
        )
      ) {
        throw new TypeError(
          "Owner-local lifecycle delivery authority differs.",
        );
      }
      draft = {
        ...draft,
        deliveryLease: {
          deliveryId: expected.deliveryId,
          owner: expected.attemptId,
        },
      };
    }
    const deduplicationId = draft.deduplicationId?.trim();
    if (!deduplicationId) {
      throw new TypeError("Action lifecycle events require deduplicationId.");
    }
    const action = options.actions
      ? actionDefinitionById(options.actions, data.actionId)
      : undefined;
    if (
      action && actionDefinitionHasSecrets(action) && !options.protectedValues
    ) {
      throw new Error(
        `Action '${action.id}' requires a configured Secret Adapter.`,
      );
    }
    if (action && actionDefinitionHasSecrets(action) && !options.store) {
      throw new Error("Protected Action lifecycle requires an Event Store.");
    }
    const prepared = action
      ? await prepareActionLifecycleBody({
        namespace: draft.namespace,
        data,
        action,
        protectedValues: options.protectedValues,
        // Only a secret input is sealed once, by the invoked receipt; a later
        // receipt of that run reuses its reference.
        existingInput: actionInputHasSecrets(action)
          ? await invokedInputRef(options, draft.namespace, data)
          : undefined,
      })
      : ({
        body: data,
        publicData: data,
        prepared: [] as const,
      } as const);
    const bodyId = `event-body:${draft.namespace}:${deduplicationId}`;
    const payload = {
      dataRef: {
        eventBodyId: bodyId,
        schemaVersion: 1,
        mediaType: "application/json" as const,
      },
    };
    const retention = action
      ? await planActionInputRetention(draft.namespace, action, data)
      : undefined;
    const tables = options.store?.tables;
    // The receipt's own statement retains the input Assets, unless protected
    // values must be adopted in code beside them.
    const inStatement = retention !== undefined && tables !== undefined &&
      prepared.prepared.length === 0;
    try {
      return await commitMutation({
        admission: {
          openActionGroup: data.status === "deferred",
          cancellation: options.writer?.kind === "cancellation",
        },
        draft: { ...draft, payload },
        matchData: prepared.publicData,
        body: { id: payload.dataRef.eventBodyId, json: prepared.body },
        ...(tables
          ? {
            statement: (param, actualTables) =>
              combineActionStatements([
                actionOwnershipStatement(
                  { draft, data },
                  options.writer,
                  attemptOwner ? actualTables : tables,
                  param,
                  commandTime,
                  attemptOwner,
                ),
                ...(inStatement
                  ? [composeActionInputRetention(retention!, tables, param)]
                  : []),
              ]),
          }
          : {}),
        ...(options.transaction
          ? { transaction: options.transaction, dispatch: false }
          : {}),
        ...(!inStatement && (retention || prepared.prepared.length > 0)
          ? {
            mutate: async (context) => {
              if (retention) await retainActionInputContent(context, retention);
              for (const value of prepared.prepared) {
                await options.protectedValues!.adopt(
                  context,
                  draft.namespace,
                  value,
                );
              }
            },
          }
          : {}),
        recoverDuplicate: async (event, context) => {
          const existing = await readEventBody(
            context,
            event.namespace,
            eventDataRef(event.payload),
          );
          if (!samePreparedActionLifecycleBody(existing, prepared.body)) {
            throw new Error(
              `Event body '${bodyId}' already exists with different content.`,
            );
          }
        },
      });
    } catch (error) {
      if (
        attemptOwner && error && typeof error === "object" && "code" in error &&
        error.code === "ActionOwnershipLost"
      ) {
        throw new ActionOwnershipLost(data.actionRunId);
      }
      throw error;
    }
  };
}

export function createActionLifecycleLoader(
  options:
    & Readonly<{ store: LifecycleStore }>
    & Omit<ActionLifecyclePersistenceOptions, "store">,
): ActionLifecycleLoader {
  return async (namespaceInput, deduplicationId) => {
    const namespace = namespaceInput.trim();
    if (!namespace) throw new TypeError("Action namespace must be non-empty.");
    const id = deduplicationId.trim();
    if (!id) {
      throw new TypeError("Action event deduplication id must be non-empty.");
    }
    const event = await options.store.getEventByDeduplicationId(namespace, id);
    if (!event) return null;
    let raw: unknown;
    try {
      raw = await rawEventBody(options.store, event);
    } catch {
      throw new Error(
        `Event '${event.id}' at Action receipt identity '${id}' is not an authoritative Action lifecycle Event.`,
      );
    }
    const resolved = withProcessorEventData(
      event,
      publicActionLifecycleData(raw),
    );
    const lifecycle = parseActionLifecycleEvent(resolved);
    if (!lifecycle) {
      throw new Error(
        `Event '${event.id}' at Action receipt identity '${id}' is not an authoritative Action lifecycle Event.`,
      );
    }
    if (!options.actions) return lifecycle as ActionEventData;
    const action = actionDefinitionById(options.actions, lifecycle.actionId);
    return await hydrateActionLifecycleBody({
      namespace,
      body: raw as ActionEventData,
      action,
      protectedValues: options.protectedValues,
    });
  };
}
