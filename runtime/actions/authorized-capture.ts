import { awaitEventPublication } from "../events/coordinator.ts";
import { assertOwnerInvocationLive } from "../engine/invocation-liveness.ts";
import type { OperationCatalog } from "../streams/catalog.ts";

import {
  authorizationRefused,
  createOwnerEvaluator,
} from "../authorization/evaluator.ts";

/** Owner-local Action policy and first input capture on the existing owner queue. */
import { captureHostCommandJson } from "../application/host-command-json.ts";
import {
  type CommandContext,
  createSchemaCommandRunner,
  schemaCommandContext,
} from "../engine/commands.ts";

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

import {
  capturePreparedActionInput,
  protectedActionPublicInput,
} from "./capture-input.ts";
import {
  assertProtectedActionSourceReplay,
  type ProtectedActionSourceBinding,
  resolveProtectedActionSource,
} from "./protected-action-source.ts";

import type { ProtectedValueRuntime } from "./protected-value.ts";
import type { ActionEventData, AnyActionDefinition } from "./types.ts";
import { durableActionValue, sameActionValue } from "./value.ts";
import { durableActionContentInput } from "./content.ts";
import type { ActionWriter } from "./ownership.ts";

export function createAuthorizedActions(
  options: Readonly<{
    authorization?: import("../authorization/evaluator.ts").OwnerAuthorization;
    collections: Readonly<
      Record<
        string,
        import("../collections/definition.ts").CollectionDefinition
      >
    >;
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
  const alias = (id: string) =>
    Object.entries(options.actions).find(([, action]) => action.id === id)?.[0];
  const definition = (id: string) =>
    options.authorization?.actions[alias(id) ?? ""];
  const evaluate = options.authorization &&
    createOwnerEvaluator({
      registration: options.authorization,
      collections: options.collections,
      databaseSchema,
    });
  const binding = (action: AnyActionDefinition) => ({
    databaseSchema,
    namespace,
    actionId: action.id,
    inputSchema: action.inputSchema ?? null,
    publicRevisionFields: [],
  });
  const matchesCapture = (intent: unknown, action: AnyActionDefinition) => {
    if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
      return false;
    }
    return sameActionValue(
      { ...intent, publicRevisionFields: [] },
      binding(action),
    );
  };
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
  // A verified terminal contains the captured input too. Replaying completed
  // work must not reopen an invoked body that is no longer needed.
  const capturedInput = async (
    tx: SqlExecutor,
    action: AnyActionDefinition,
    runId: string,
  ) => {
    const event = (await tx.query<{ payload: unknown }>(
      `SELECT payload FROM ${store.tables.events} WHERE namespace=$1 AND deduplication_id IN ($2,$3)
       ORDER BY CASE WHEN deduplication_id=$2 THEN 0 ELSE 1 END LIMIT 1`,
      [namespace, `${runId}:action:terminal`, `${runId}:action:invoked`],
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
      !["invoked", "completed", "failed", "cancelled"].includes(data.status) ||
      data.actionId !== action.id ||
      data.actionRunId !== runId
    ) throw new Error("Protected Action input capture is invalid.");
    return data;
  };
  const authorize = async (
    command: CommandContext,
    frame: Pick<
      ActionInvocationFrame,
      "actionId" | "actionRunId" | "parentActionRunId" | "signal"
    >,
    input: unknown,
    source: ProtectedActionSourceBinding,
    firstCapture = false,
  ) => {
    await authority(command, frame);
    if (!evaluate) authorizationRefused();
    const resolved = await resolveProtectedActionSource({
      transaction: command.transaction,
      databaseSchema,
      namespace,
      source,
      protectedValues: options.protectedValues,
    });
    const retained = (await command.transaction.query<
      {
        authority:
          import("../authorization/authority.ts").AuthenticatedAuthority;
      }
    >(
      `SELECT authority FROM ${store.tables.authorization_invocations} WHERE namespace=$1 AND run_id=$2`,
      [namespace, frame.actionRunId],
    )).rows[0];
    const binding = retained?.authority ??
      (firstCapture
        ? resolved.ingress?.authority ??
          resolved.ancestors.find((entry) => entry.ingress?.authority)?.ingress
            ?.authority
        : undefined);
    if (
      !binding && resolved.ingress?.kind === "host" &&
      !resolved.ingress.authority
    ) {
      return {
        input: captureHostCommandJson(input),
        metadata: captureHostCommandJson(
          "metadata" in frame ? frame.metadata as Record<string, unknown> : {},
        ),
      };
    }
    if (!binding) authorizationRefused();
    const decision = await evaluate(binding, {
      kind: "action",
      resource: alias(frame.actionId)!,
      operation: firstCapture ? "capture" : "authorize",
      sourceOperationId: resolved.ancestors[0]?.event.id ?? resolved.event.id,
      invocation: {
        kind: "action",
        id: frame.actionId,
        runId: frame.actionRunId,
      },
      input,
    }, command);
    const policy = decision.constraints.actions?.[alias(frame.actionId)!] ??
      decision.constraints.actions?.[frame.actionId];
    if (!policy) authorizationRefused();
    await authority(command, frame);
    const metadata = captureHostCommandJson({
      ...("metadata" in frame ? frame.metadata as Record<string, unknown> : {}),
      ...decision.constraints.actionMetadata,
    });
    if (!firstCapture) {
      return { input: captureHostCommandJson(input), metadata };
    }
    await command.transaction.query(
      `INSERT INTO ${store.tables.authorization_invocations}(namespace,run_id,source_event_id,authority) VALUES($1,$2,$3,$4::jsonb)`,
      [
        namespace,
        frame.actionRunId,
        source.eventId,
        JSON.stringify({
          ...decision.authority,
          dependencies: decision.dependencies,
        }),
      ],
    );
    if (!policy.input) {
      return { input: captureHostCommandJson(input), metadata };
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      authorizationRefused();
    }
    const candidate =
      input && typeof input === "object" && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
    for (const [key, value] of Object.entries(policy.input ?? {})) {
      if (
        Object.hasOwn(candidate, key) && !sameActionValue(candidate[key], value)
      ) authorizationRefused();
    }
    return {
      input: captureHostCommandJson({ ...candidate, ...policy.input }),
      metadata,
    };
  };
  const prepareInput = (
    frame: ActionInvocationFrame,
    raw: unknown,
    transaction?: SqlExecutor,
  ):
    | Promise<
      {
        input: unknown;
        claimed: boolean;
        metadata: import("./types.ts").ActionInvocationMetadata;
      }
    >
    | undefined => {
    if (!definition(frame.actionId)) return;
    const action = actionDefinitionById(options.actions, frame.actionId);
    const input = captureHostCommandJson(
      action.content
        ? durableActionContentInput(raw, action.content)
        : durableActionValue(raw),
    );
    const request = protectedActionPublicInput(
      action,
      input,
      [],
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
          const existing = await capturedInput(
            command.transaction,
            action,
            frame.actionRunId,
          );
          if (prior) {
            if (
              !existing || !matchesCapture(prior.intent, action) ||
              !sameActionValue(
                prior.result.request,
                protectedActionPublicInput(
                  action,
                  input,
                  (prior.intent as { publicRevisionFields: readonly string[] })
                    .publicRevisionFields,
                ),
              ) ||
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
            return {
              input: captured,
              claimed: false,
              metadata: existing.metadata ?? {},
            };
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
          const decision = await authorize(command, frame, input, source, true);
          const prepared = decision.input;
          const metadata = decision
            .metadata as import("./types.ts").ActionInvocationMetadata;
          capturePreparedActionInput(action, prepared, prepared);
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
            metadata,
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
          return { input: prepared, claimed: true, metadata };
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
    if (!definition(frame.actionId)) return {};
    const action = actionDefinitionById(options.actions, frame.actionId);
    const captured = async (tx: SqlExecutor) => {
      const prior = await read(tx, frame.actionRunId);
      const input = await capturedInput(tx, action, frame.actionRunId);
      if (
        !prior || !input || !matchesCapture(prior.intent, action) ||
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
