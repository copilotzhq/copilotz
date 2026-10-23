import {
  assertMetadataIsSecretFree,
  protectedActionStrings,
} from "./secret.ts";
import { awaitEventPublication } from "../events/coordinator.ts";
import {
  afterCommandAuthorization,
  createSchemaCommandRunner,
} from "../engine/commands.ts";
import {
  prepareActionOperation,
  startAwaitedOperation,
} from "./continuation-work.ts";
import { actionOwnershipStatement, type ActionWriter } from "./ownership.ts";
import type { SqlExecutor } from "../events/session.ts";
import type { EventCoordinator } from "../events/index.ts";
import type { DurableEvent, EventStore } from "../events/index.ts";
import {
  EVENT_BODY_SCHEMA_VERSION,
  eventDataRef,
  readEventBody,
  verifiedEventBody,
} from "../events/body-store.ts";
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

type LifecycleStore =
  & Pick<
    EventStore,
    "getEventByDeduplicationId" | "session" | "tables"
  >
  & Partial<Pick<EventStore, "databaseSchema" | "recentEventBody">>;

type ActionLifecyclePersistenceOptions = Readonly<{
  store?: LifecycleStore;
  actions?: Readonly<Record<string, AnyActionDefinition>>;
  protectedValues?: ProtectedValueRuntime;
  writer?: ActionWriter;
  transaction?: SqlExecutor;
  finishTerminal?(
    transaction: SqlExecutor,
    data: ActionEventData,
  ): Promise<void>;
  protectedActionOutput?(
    data: ActionEventData,
  ): { authorize?(transaction: SqlExecutor): Promise<void> };
}>;

async function rawEventBody(
  store:
    & Pick<EventStore, "session" | "tables">
    & Partial<Pick<EventStore, "recentEventBody">>,
  event: DurableEvent,
): Promise<unknown> {
  const ref = eventDataRef(event.payload);
  const cached = ref.schemaVersion === EVENT_BODY_SCHEMA_VERSION
    ? store.recentEventBody?.(event.id, ref.eventBodyId)
    : undefined;
  return cached ? cached.json : await readEventBody(
    { transaction: store.session, tables: store.tables },
    event.namespace,
    ref,
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
  const receipt = (await executor.query<{
    payload: unknown;
    body: unknown;
    schema_version: number | null;
    digest: string;
  }>(
    `SELECT event.payload,body.body,body.schema_version,body.digest
     FROM ${options.store.tables.events} AS event
     LEFT JOIN ${options.store.tables.event_bodies} AS body
       ON body.namespace=event.namespace AND body.event_body_id=event.payload->'dataRef'->>'eventBodyId'
     WHERE event.namespace=$1 AND event.deduplication_id=$2`,
    [namespace, deduplicationId],
  )).rows[0];
  if (!receipt) {
    throw new Error(
      `Protected Action invoked receipt '${data.actionRunId}' is missing.`,
    );
  }
  const ref = eventDataRef(receipt.payload);
  if (receipt.schema_version === null) {
    throw new Error(`Event body '${ref.eventBodyId}' was not found.`);
  }
  const body = protectedActionLifecycleBody(
    await verifiedEventBody({
      ...receipt,
      schema_version: receipt.schema_version,
    }, ref),
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
    if (action && data.status === "invoked" && actionInputHasSecrets(action)) {
      const secrets = protectedActionStrings(action.inputSchema, data.input);
      assertMetadataIsSecretFree(data.metadata, secrets);
      // Runtime-generated action coordinates are not caller metadata. The
      // inherited origin is checked before the first capture can commit.
      const { actionId: _id, actionStatus: _status, ...origin } =
        draft.metadata ?? {};
      assertMetadataIsSecretFree(origin, secrets);
    }
    const outputHooks = options.protectedActionOutput?.(data);
    const prepared = action
      ? await prepareActionLifecycleBody({
        namespace: draft.namespace,
        data,
        action,
        awaitedAction: data.status === "awaiting" && data.start
          ? options.actions?.[data.start.action]
          : undefined,
        protectedValues: options.protectedValues,
        transaction: options.transaction,
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
      await awaitEventPublication(result);
      await flush();
      return result;
    }

    if (
      (options.finishTerminal && !data.parentActionRunId &&
        ["completed", "failed", "cancelled"].includes(data.status)) ||
      (data.status === "completed" && outputHooks?.authorize &&
        options.store?.databaseSchema)
    ) {
      const complete = async (transaction: SqlExecutor) => {
        if (data.status === "completed") {
          await outputHooks?.authorize?.(transaction);
        }
        const result = await commit(transaction);
        if (options.finishTerminal && !data.parentActionRunId) {
          afterCommandAuthorization(
            transaction,
            () => options.finishTerminal!(transaction, data),
          );
        }
        return result;
      };
      if (options.transaction) return await complete(options.transaction);
      const result = await createSchemaCommandRunner(
        options.store!.session,
        options.store!.databaseSchema!,
      )(
        "actions.terminal",
        { actionRunId: data.actionRunId },
        (_input, command) => complete(command.transaction),
      );
      await awaitEventPublication(result);
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
    if (!event) {
      if (!id.endsWith(":action:terminal")) return null;
      const runId = id.slice(0, -":action:terminal".length);
      // Offline conversion receipts attest status only. They carry no output
      // or invented Event body/digest and can never reopen an old invocation.
      const retained = (await options.store.session.query<{
        result: {
          status: "completed" | "failed" | "cancelled";
          actionId: string;
          namespace: string;
          runId: string;
          bodyId: string;
          bodyDigest: string;
          terminalSource: string;
          reason?: string;
        };
        body: unknown;
        digest: string;
        schema_version: number;
      }>(
        `SELECT r.result,b.body,b.digest,b.schema_version
        FROM ${options.store.tables.owner_receipts} r
        LEFT JOIN ${options.store.tables.event_bodies} b ON b.namespace=$1 AND b.event_body_id=r.result->>'bodyId'
        WHERE r.owner='schema' AND r.domain='logical' AND r.kind='action.upgrade-terminal' AND r.key=$2`,
        [
          namespace,
          JSON.stringify(["action.upgrade-terminal", namespace, runId]),
        ],
      )).rows[0];
      if (!retained) return null;
      const evidence = retained.result;
      if (
        !retained.body || evidence.namespace !== namespace ||
        evidence.runId !== runId ||
        !["completed", "failed", "cancelled"].includes(evidence.status) ||
        !["wrapper-attested", "reviewed-abandonment"].includes(
          evidence.terminalSource,
        )
      ) {
        throw new Error(
          "Retained terminal evidence is missing or inconsistent.",
        );
      }
      // Source digests in the receipt describe v11 evidence. Later reviewed
      // key conversion may re-encode a capture; verify its current digest below.
      const raw = await verifiedEventBody(retained, {
        eventBodyId: evidence.bodyId,
        schemaVersion: retained.schema_version,
        mediaType: "application/json",
      });
      const invoked = publicActionLifecycleData(raw) as ActionEventData;
      if (
        invoked.status !== "invoked" || invoked.actionRunId !== runId ||
        invoked.actionId !== evidence.actionId
      ) throw new Error("Retained terminal identity changed.");
      return {
        actionRunId: invoked.actionRunId,
        actionId: invoked.actionId,
        input: invoked.input,
        metadata: invoked.metadata,
        ...(invoked.parentActionRunId
          ? { parentActionRunId: invoked.parentActionRunId }
          : {}),
        status: evidence.status,
        terminalSource: evidence.terminalSource,
        ...(evidence.reason ? { reason: evidence.reason } : {}),
        ...(evidence.status === "completed" ? {} : {
          error: {
            name: "RetainedHistoryTerminal",
            message: evidence.reason ??
              `Historical Action ${evidence.status}; outcome attested by retained wrapper.`,
          },
        }),
      } as ActionEventData;
    }
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
