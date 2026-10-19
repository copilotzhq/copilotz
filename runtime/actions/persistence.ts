import {
  adoptCapturedActionOutput,
  assertCapturedActionOutput,
  prepareCapturedActionOutput,
  readCapturedActionOutput,
} from "./protected-effect-output.ts";
import { copy } from "./effect-client.ts";
import { actionSchemaHasSecrets } from "./secret.ts";
import type { ActionEffectOutcome } from "./types.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import {
  prepareActionOperation,
  startAwaitedOperation,
} from "./continuation-work.ts";
import { actionOwnershipStatement, type ActionWriter } from "./ownership.ts";
import type { SqlExecutor } from "../events/session.ts";
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
  PROTECTED_ACTION_LIFECYCLE_SCHEMA,
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

type LifecycleStore =
  & Pick<
    EventStore,
    "getEventByDeduplicationId" | "session" | "tables"
  >
  & Partial<Pick<EventStore, "databaseSchema">>;

type ActionLifecyclePersistenceOptions = Readonly<{
  store?: LifecycleStore;
  actions?: Readonly<Record<string, AnyActionDefinition>>;
  protectedValues?: ProtectedValueRuntime;
  writer?: ActionWriter;
  transaction?: SqlExecutor;
  protectedActionOutput?(
    data: ActionEventData,
  ): Pick<
    import("./protected-effect-output.ts").ActionOutputBinding,
    "authorize" | "accept"
  >;
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
    & Readonly<{ coordinator: EventCoordinator }>
    & ActionLifecyclePersistenceOptions,
): ActionLifecycleAppender {
  return async ({ draft, data }) => {
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
    const outputHooks = options.protectedActionOutput?.(data);
    const outputBinding = action &&
        (actionSchemaHasSecrets(action.outputSchema) || outputHooks?.accept) &&
        options.protectedValues && options.store
      ? {
        action,
        ...outputHooks,
        protectedValues: options.protectedValues,
        databaseSchema: options.store.databaseSchema!,
        namespace: draft.namespace,
        actionRunId: data.actionRunId,
      }
      : undefined;
    const existingOutput = data.status === "completed" && outputBinding
      ? await readCapturedActionOutput(
        options.transaction ?? options.store!.session,
        outputBinding,
      )
      : undefined;
    if (
      existingOutput && data.status === "completed" && !outputBinding?.authorize
    ) {
      await assertCapturedActionOutput(
        outputBinding!,
        existingOutput,
        copy(data.output) as ActionEffectOutcome,
        options.transaction,
      );
    }
    let prepared = action
      ? await prepareActionLifecycleBody({
        namespace: draft.namespace,
        data,
        action,
        awaitedAction: data.status === "awaiting" && data.start
          ? options.actions?.[data.start.action]
          : undefined,
        protectedValues: options.protectedValues,
        transaction: options.transaction,
        existingOutput: existingOutput?.ref,
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
    const tables = options.store?.tables;
    const commit = (transaction?: SqlExecutor) =>
      options.coordinator.commitMutation({
        admission: {
          cancellation: options.writer?.kind === "cancellation",
        },
        draft: { ...draft, payload },
        matchData: prepared.publicData,
        body: { id: payload.dataRef.eventBodyId, json: prepared.body },
        ...(tables
          ? {
            statement: (param, _tables, { commandTime }) =>
              actionOwnershipStatement(
                { draft, data },
                options.writer,
                tables,
                param,
                commandTime,
              ),
          }
          : {}),
        ...(transaction ? { transaction, dispatch: false } : {}),
        ...(prepared.prepared.length > 0
          ? {
            mutate: async (context) => {
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
    if (data.status === "awaiting" && !options.transaction) {
      if (!options.store) {
        throw new TypeError("Awaiting requires an Event Store.");
      }
      const store = options.store as EventStore;
      const preparedChild = data.start
        ? await prepareActionOperation(
          {
            store,
            coordinator: options.coordinator,
            actions: options.actions,
            protectedValues: options.protectedValues,
          },
          draft.namespace,
          data.operationId ?? data.start.operationId ??
            `${data.actionRunId}:child`,
          data.start,
        )
        : undefined;
      let flush!: () => Promise<void>;
      const result = await createSchemaCommandRunner(
        store.session,
        store.databaseSchema,
      )(
        "actions.await",
        { actionRunId: data.actionRunId },
        async (_input, { transaction }) => {
          const appended = await commit(transaction);
          flush = await startAwaitedOperation(
            {
              store,
              coordinator: options.coordinator,
              actions: options.actions,
              protectedValues: options.protectedValues,
            },
            transaction,
            { draft, data },
            options.writer,
            preparedChild,
          );
          return appended;
        },
      );
      await options.coordinator.flushCommitted(result);
      await flush();
      return result;
    }

    if (data.status === "completed" && outputBinding) {
      const commitOutput = async (transaction: SqlExecutor) => {
        // Recheck in the same owner transaction as terminal acceptance. A racing
        // output confirmation cannot revise or be revised by the terminal.
        let accepted = await readCapturedActionOutput(
          transaction,
          outputBinding,
        );
        if (!accepted) {
          const protectedBody = protectedActionLifecycleBody(prepared.body);
          const outputRef = protectedBody?.protected.output;
          const staged = prepared.prepared.find((value) =>
            value.ref.ownerNodeId === outputRef?.ownerNodeId
          ) ??
            await prepareCapturedActionOutput(
              outputBinding,
              copy(data.output) as ActionEffectOutcome,
              transaction,
            );
          accepted = await adoptCapturedActionOutput(
            transaction,
            outputBinding,
            copy(data.output) as ActionEffectOutcome,
            staged,
          );
        }
        if (accepted) {
          await assertCapturedActionOutput(
            outputBinding,
            accepted,
            copy(data.output) as ActionEffectOutcome,
            transaction,
          );
          const protectedBody = protectedActionLifecycleBody(prepared.body) ?? {
            schema: PROTECTED_ACTION_LIFECYCLE_SCHEMA,
            data: prepared.publicData,
            protected: {},
          };
          const obsolete = "output" in protectedBody.protected
            ? protectedBody.protected.output
            : undefined;
          prepared = {
            ...prepared,
            body: {
              ...protectedBody,
              protected: { ...protectedBody.protected, output: accepted.ref },
            },
            prepared: prepared.prepared.filter((value) =>
              value.ref !== obsolete &&
              value.ref.ownerNodeId !== obsolete?.ownerNodeId
            ),
          };
        }
        return await commit(transaction);
      };
      if (options.transaction) return await commitOutput(options.transaction);
      const result = await createSchemaCommandRunner(
        options.store!.session,
        outputBinding.databaseSchema,
      )(
        "actions.completeOutput",
        { actionRunId: data.actionRunId },
        async (_input, { transaction }) => await commitOutput(transaction),
      );
      await options.coordinator.flushCommitted(result);
      return result;
    }
    if (
      data.status === "completed" && outputHooks?.authorize &&
      options.store?.databaseSchema
    ) {
      const completeAuthorized = async (transaction: SqlExecutor) => {
        await outputHooks.authorize!(transaction);
        return await commit(transaction);
      };
      if (options.transaction) {
        return await completeAuthorized(options.transaction);
      }
      const result = await createSchemaCommandRunner(
        options.store.session,
        options.store.databaseSchema,
      )(
        "actions.completeAuthorized",
        { actionRunId: data.actionRunId },
        async (_, command) => await completeAuthorized(command.transaction),
      );
      await options.coordinator.flushCommitted(result);
      return result;
    }
    return await commit(options.transaction);
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
