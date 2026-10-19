import { awaitEventPublication } from "../events/coordinator.ts";
import { assertOwnerInvocationLive } from "../engine/invocation-liveness.ts";
import type { OperationCatalog } from "../streams/catalog.ts";
import { standardActionError } from "./errors.ts";
import { withOwnerAuthorizationPhase } from "../engine/command-authorization.ts";
import {
  isOwnerAuthorizationRefusal,
  markOwnerAuthorizationRefusal,
  withOwnerPolicyRefusal,
} from "../engine/authorization-refusal.ts";

/** Owner-local Action policy and first input capture on the existing owner queue. */
import { captureHostCommandJson } from "../application/host-command-json.ts";
import {
  bindCommandExecutorAlias,
  type CommandContext,
  createSchemaCommandRunner,
  schemaCommandContext,
} from "../engine/commands.ts";
import { withOwnerQueryContext } from "../engine/owner-query-context.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import type {
  EventCoordinator,
  EventStore,
  SqlExecutor,
} from "../events/index.ts";
import type { ActionInvocationFrame } from "./invoker.ts";
import { createActionLifecycleAppender } from "./persistence.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import {
  actionDefinitionById,
  hydrateActionLifecycleBody,
} from "./protected-lifecycle.ts";
import { withProtectedEventResolver } from "./protected-context.ts";
import {
  assertProtectedActionMetadata,
  capturePreparedActionInput,
  protectedActionPublicInput,
} from "./protected-action-policy.ts";
import {
  assertProtectedActionSourceReplay,
  type ProtectedActionSourceBinding,
  resolveProtectedActionSource,
} from "./protected-action-source.ts";
import type {
  ProtectedActionDefinitions,
  ProtectedActionOwnerContext,
} from "./protected-action-types.ts";
import type { ProtectedValueRuntime } from "./protected-value.ts";
import type { ActionEventData, AnyActionDefinition } from "./types.ts";
import { sameActionValue } from "./value.ts";
import type { ActionWriter } from "./ownership.ts";

export function createProtectedActions(
  options: Readonly<{
    definitions: ProtectedActionDefinitions;
    actions: Readonly<Record<string, AnyActionDefinition>>;
    store: EventStore;
    coordinator: EventCoordinator;
    operationCatalog?: Pick<OperationCatalog, "admitEventSql">;
    namespace: string;
    source?: ProtectedActionSourceBinding;
    writer?: ActionWriter;
    signal: AbortSignal;
    protectedValues?: ProtectedValueRuntime;
    lifecycleMetadata?: Readonly<Record<string, unknown>>;
  }>,
) {
  const { store, namespace } = options;
  const databaseSchema = store.databaseSchema;
  const key = (runId: string) =>
    JSON.stringify(["action.protected-input", namespace, runId]);
  const definition = (id: string) => options.definitions[id];
  const binding = (action: AnyActionDefinition) => ({
    databaseSchema,
    namespace,
    actionId: action.id,
    inputSchema: action.inputSchema ?? null,
    publicRevisionFields: definition(action.id)?.publicRevisionFields ?? [],
  });
  const authority = async (
    command: CommandContext,
    frame: Pick<ActionInvocationFrame, "actionRunId" | "actionId" | "signal">,
  ) => {
    options.signal.throwIfAborted();
    frame.signal.throwIfAborted();
    if (options.writer?.kind === "delivery") {
      if (!options.source) {
        throw new Error("Protected Action execution source is unavailable.");
      }
      // Input capture precedes the open Action obligation, and a completed
      // child may be replayed by its still-live parent delivery.
      await assertOwnerInvocationLive(command, {
        databaseSchema,
        namespace,
        operationCatalog: options.operationCatalog,
        operationId: options.source.operationId,
        eventId: options.source.eventId,
        writer: options.writer,
      });
    } else if (options.writer) {
      throw new Error("Protected Action hooks require an active execution.");
    }
  };
  const read = async (tx: SqlExecutor, runId: string) =>
    (await tx.query<
      {
        intent: unknown;
        result: { source: ProtectedActionSourceBinding; request: unknown };
      }
    >(
      `SELECT intent,result FROM ${store.tables.owner_receipts} WHERE owner='schema' AND domain='logical' AND key=$1 AND kind='action.protected-input'`,
      [key(runId)],
    )).rows[0];
  const invoked = async (
    tx: SqlExecutor,
    action: AnyActionDefinition,
    runId: string,
  ) => {
    const event = (await tx.query<{ payload: unknown }>(
      `SELECT payload FROM ${store.tables.events} WHERE namespace=$1 AND deduplication_id=$2`,
      [namespace, `${runId}:action:invoked`],
    )).rows[0];
    if (!event) return;
    const body = await readEventBody(
      { transaction: tx, tables: store.tables },
      namespace,
      eventDataRef(event.payload),
    );
    const data = await hydrateActionLifecycleBody({
      namespace,
      body: body as ActionEventData,
      action,
      protectedValues: options.protectedValues,
      transaction: tx,
    });
    if (
      data.status !== "invoked" || data.actionId !== action.id ||
      data.actionRunId !== runId
    ) throw new Error("Protected Action input capture is invalid.");
    return data;
  };
  const phase = <T>(
    command: CommandContext,
    frame: Pick<
      ActionInvocationFrame,
      "actionId" | "actionRunId" | "parentActionRunId" | "signal"
    >,
    input: unknown,
    source: ProtectedActionSourceBinding,
    run: (context: ProtectedActionOwnerContext) => T | Promise<T>,
  ) => {
    const signal = AbortSignal.any([
      options.signal,
      frame.signal,
      command.signal,
    ]);
    let infrastructureFailed = false;
    const watch = <V>(promise: Promise<V>): Promise<V> =>
      promise.catch((error) => {
        infrastructureFailed = true;
        throw error;
      });
    return withOwnerQueryContext(
      run,
      command,
      signal,
      (assertActive, query, track) => {
        const watchedQuery: typeof query = (sql, params) => {
          try {
            return watch(query(sql, params));
          } catch (error) {
            infrastructureFailed = true;
            throw error;
          }
        };
        const transaction = { query: watchedQuery };
        bindCommandExecutorAlias(
          transaction,
          command.transaction,
          assertActive,
        );
        const resolveSource = () => {
          try {
            assertActive();
          } catch (error) {
            return Promise.reject(error);
          }
          return track(
            watch(resolveProtectedActionSource({
              transaction,
              databaseSchema,
              namespace,
              source,
              protectedValues: options.protectedValues,
            })).then((value) => {
              assertActive();
              return value;
            }),
          );
        };
        return withProtectedEventResolver({
          query: watchedQuery,
          scope: Object.freeze({ databaseSchema, namespace }),
          action: Object.freeze({
            id: frame.actionId,
            runId: frame.actionRunId,
            ...(frame.parentActionRunId
              ? { parentRunId: frame.parentActionRunId }
              : {}),
          }),
          input: captureHostCommandJson(input),
          resolveSource,
        }, async () => (await resolveSource()).data);
      },
    ).catch((caught) => {
      if (signal.aborted) {
        throw new DOMException(
          "Protected Action owner phase was cancelled.",
          "AbortError",
        );
      }
      const error = standardActionError(caught) ??
        new Error("Protected Action owner phase failed.");
      throw !infrastructureFailed && isOwnerAuthorizationRefusal(caught)
        ? markOwnerAuthorizationRefusal(error)
        : error;
    });
  };
  const authorize = async (
    command: CommandContext,
    frame: Pick<
      ActionInvocationFrame,
      "actionId" | "actionRunId" | "parentActionRunId" | "signal"
    >,
    input: unknown,
    source: ProtectedActionSourceBinding,
  ) => {
    await authority(command, frame);
    const hook = definition(frame.actionId)!;
    await withOwnerAuthorizationPhase(() =>
      phase(
        command,
        frame,
        input,
        source,
        (context) =>
          withOwnerPolicyRefusal(
            () => hook.authorize(input, context),
            context.signal,
          ),
      )
    );
    await authority(command, frame);
  };
  const prepareInput = (
    frame: ActionInvocationFrame,
    raw: unknown,
    transaction?: SqlExecutor,
  ): Promise<{ input: unknown; claimed: boolean }> | undefined => {
    const hook = definition(frame.actionId);
    if (!hook) return;
    const input = captureHostCommandJson(raw);
    const action = actionDefinitionById(options.actions, frame.actionId);
    const request = protectedActionPublicInput(
      action,
      input,
      hook.publicRevisionFields,
    );
    return (async () => {
      let committed:
        | Awaited<ReturnType<EventCoordinator["commitMutation"]>>
        | undefined;
      const result = await createSchemaCommandRunner(
        transaction ?? store.session,
        databaseSchema,
      )(
        "actions.prepareProtectedInput",
        { actionRunId: frame.actionRunId },
        async (_input, command) => {
          await authority(command, frame);
          const prior = await read(command.transaction, frame.actionRunId);
          const existing = await invoked(
            command.transaction,
            action,
            frame.actionRunId,
          );
          if (prior) {
            if (
              !existing || !sameActionValue(prior.intent, binding(action)) ||
              !sameActionValue(prior.result.request, request) ||
              existing.parentActionRunId !== frame.parentActionRunId
            ) {
              throw new Error(
                "Protected Action invocation differs from its captured binding.",
              );
            }
            await assertProtectedActionSourceReplay({
              transaction: command.transaction,
              databaseSchema,
              namespace,
              original: prior.result.source,
              current: options.source,
            });
            const captured = captureHostCommandJson(existing.input);
            await authorize(command, frame, captured, prior.result.source);
            return { input: captured, claimed: false };
          }
          if (existing) {
            throw new Error(
              "Protected Action owner preparation receipt is missing.",
            );
          }
          if (!options.source) {
            throw new Error(
              "Protected Action requires retained invocation provenance.",
            );
          }
          const source = options.source;
          await authorize(command, frame, input, source);
          const prepared = hook.prepareInput
            ? await withOwnerAuthorizationPhase(() =>
              phase(command, frame, input, source, (context) => {
                const value = withOwnerPolicyRefusal(
                  () => hook.prepareInput!(input, context),
                  context.signal,
                );
                return value instanceof Promise
                  ? value.then((value) =>
                    capturePreparedActionInput(
                      action,
                      input,
                      value,
                      hook.publicRevisionFields,
                    )
                  )
                  : capturePreparedActionInput(
                    action,
                    input,
                    value,
                    hook.publicRevisionFields,
                  );
              })
            )
            : capturePreparedActionInput(
              action,
              input,
              input,
              hook.publicRevisionFields,
            );
          assertProtectedActionMetadata(action, prepared, frame.metadata);
          assertProtectedActionMetadata(
            action,
            prepared,
            options.lifecycleMetadata ?? {},
          );
          await authority(command, frame);
          const lifecycle = createActionLifecycleEmitter({
            namespace,
            metadata: options.lifecycleMetadata,
            append: createActionLifecycleAppender({
              coordinator: options.coordinator,
              store,
              actions: options.actions,
              protectedValues: options.protectedValues,
              writer: options.writer,
              transaction: command.transaction,
            }),
          });
          committed = await lifecycle.emit({
            actionRunId: frame.actionRunId,
            actionId: frame.actionId,
            ...(frame.parentActionRunId
              ? { parentActionRunId: frame.parentActionRunId }
              : {}),
            metadata: frame.metadata,
            input: prepared,
            ...frame.identity,
            status: "invoked",
            effectProtocol: 1,
            deduplicationId: `${frame.actionRunId}:action:invoked`,
          }) as Awaited<ReturnType<EventCoordinator["commitMutation"]>>;
          await command.transaction.query(
            `INSERT INTO ${store.tables.owner_receipts}(owner,domain,key,principal,kind,intent,result) VALUES('schema','logical',$1,'runtime','action.protected-input',$2::jsonb,$3::jsonb)`,
            [
              key(frame.actionRunId),
              JSON.stringify(binding(action)),
              JSON.stringify({ source, request }),
            ],
          );
          if (transaction && committed) {
            const captured = committed;
            command.afterCommit(async () => {
              await awaitEventPublication(captured);
            });
          }
          return { input: prepared, claimed: true };
        },
      );
      if (committed && !transaction) {
        await awaitEventPublication(committed);
      }
      return result;
    })();
  };
  const output = (
    frame: Pick<
      ActionInvocationFrame,
      "actionId" | "actionRunId" | "parentActionRunId" | "signal"
    >,
  ) => {
    const hook = definition(frame.actionId);
    if (!hook) return {};
    const action = actionDefinitionById(options.actions, frame.actionId);
    const captured = async (tx: SqlExecutor) => {
      const prior = await read(tx, frame.actionRunId);
      const input = await invoked(tx, action, frame.actionRunId);
      if (
        !prior || !input || !sameActionValue(prior.intent, binding(action)) ||
        input.parentActionRunId !== frame.parentActionRunId
      ) throw new Error("Protected Action owner capture is unavailable.");
      await assertProtectedActionSourceReplay({
        transaction: tx,
        databaseSchema,
        namespace,
        original: prior.result.source,
        current: options.source,
      });
      return {
        input: captureHostCommandJson(input.input),
        source: prior.result.source,
      };
    };
    return {
      authorize: async (tx: SqlExecutor) => {
        const value = await captured(tx);
        await authorize(
          schemaCommandContext(tx, databaseSchema),
          frame,
          value.input,
          value.source,
        );
      },
    };
  };
  return { prepareInput, output };
}
