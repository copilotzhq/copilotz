import { assertOwnerInvocationLive } from "../engine/invocation-liveness.ts";
import { inheritActionInvocationParent } from "./invocation-parent.ts";
import { withOwnerPolicyRefusal } from "../engine/authorization-refusal.ts";
import type { CollectionPolicyRegistrations } from "../collections/policy-registration.ts";
import { withOwnerAuthorizationPhase } from "../engine/command-authorization.ts";
import {
  preparationActionDescendants,
  preparationOperationDescendants,
} from "./preparation-inventory.ts";
import {
  NAMED_PREPARATION_INTEGRITY as INTEGRITY,
  NAMED_PREPARATION_MARKER as MARKER,
  preparationIntegrity,
} from "./preparation-proof.ts";
import {
  createOperationCatalogTables,
  type OperationCatalog,
} from "../streams/catalog.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import {
  actionContentDeclaration,
  prepareActionContentInput,
} from "./content.ts";
import type { RuntimeContent } from "./types.ts";
import {
  assertProtectedActionSourceReplay,
  resolveProtectedActionSource,
} from "./protected-action-source.ts";
import { withOwnerQueryContext } from "../engine/owner-query-context.ts";
/** Named preparation uses the existing Action/event and owner-command lifecycle.
 * Captured input belongs only to the invoked Event Body; provenance is not a grant. */
import type { PluginRegistry } from "../plugins/registry.ts";
import type { ViewShows } from "../views/definition.ts";
import { viewShowsKey } from "../views/definition.ts";
import {
  createPreparationRenderer,
  type PreparedViewSelection,
} from "../views/preparation.ts";
import {
  type CommandContext,
  createSchemaCommandRunner,
  schemaCommandContext,
} from "../engine/commands.ts";
import type {
  EventCoordinator,
  EventStore,
  SqlExecutor,
} from "../events/index.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import type { ContentResolver } from "../content/resolver.ts";
import type { ActionInvocationFrame } from "./invoker.ts";
import type { ActionEventData, ActionInvocationMetadata } from "./types.ts";
import type { ActionWriter } from "./ownership.ts";
import type { ProtectedValueRuntime } from "./protected-value.ts";
import {
  actionDefinitionById,
  hydrateActionLifecycleBody,
  publicActionLifecycleData,
} from "./protected-lifecycle.ts";
import { createActionLifecycleAppender } from "./persistence.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import { actionPreparationIntent } from "./preparation-intent.ts";
import {
  ACTION_PREPARATION_SCHEMA,
  type ActionPreparationCapture,
  parseActionPreparationCapture,
} from "./preparation-capture.ts";
import {
  createPreparationSource,
  type PreparationActionBinding,
  type PreparationContext,
  type PreparationPolicyAuthority,
  type PreparationPurpose,
  type PreparationSourcePolicy,
} from "./preparation-source.ts";
import {
  createPreparationResources,
  type PreparationResourceCoordinate,
  type PreparationResourcesOptions,
} from "./preparation-resources.ts";
import {
  assertPreparationProjection,
  preparationCanonical as canonical,
  preparationData as snapshot,
  preparationError as fail,
  preparationRefusal as refuse,
  preparationText as text,
} from "./preparation-data.ts";
import {
  type ActionNamedPreparation,
  normalizeActionNamedPreparation,
} from "../execution/preparation-call.ts";

export type ActionPreparationRegistration = Readonly<{
  source: string;
  actionAlias: string;
  shows: ViewShows;
  modes: readonly string[];
  resources?: readonly PreparationResourceCoordinate[];
  /** Pure owner-local mapping. It may run again after rollback; side effects,
   * runtime capabilities, and persistence are not part of this contract. */
  mapInput(
    text: string,
    context: Readonly<
      {
        selection: PreparedViewSelection;
        hints: Readonly<{ mode: string; renderer: "text" }>;
        signal: AbortSignal;
      }
    >,
  ): unknown | Promise<unknown>;
}>;
export type ActionPreparations = Readonly<{
  registrations: Readonly<Record<string, ActionPreparationRegistration>>;
  source: PreparationSourcePolicy;
  projectResource: PreparationResourcesOptions["projectResource"];
  authorizeResource: PreparationResourcesOptions["authorizeResource"];
  /** Current authorization of the captured original selection, including fallback. */
  authorizeView(
    tx: SqlExecutor,
    input: Readonly<
      {
        binding: PreparationActionBinding;
        view: ActionPreparationCapture["view"];
        purpose: PreparationPurpose;
        commandTime: string;
        signal: AbortSignal;
      } & PreparationPolicyAuthority
    >,
  ): boolean | Promise<boolean>;
  maxPendingRenders?: number;
  renderTimeoutMs?: number;
  maxBytes?: number;
}>;
const KIND = "actions.prepareNamed";
export const preparationReceiptKey = (
  namespace: string,
  parentOperationKey: string,
  operationKey: string,
) => JSON.stringify([KIND, namespace, parentOperationKey, operationKey]);
function properties(
  value: unknown,
  allowed: readonly string[],
): Record<string, PropertyDescriptor> {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) fail();
  const result = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some((key) =>
      typeof key !== "string" || !allowed.includes(key)
    ) || Object.values(result).some((item) =>
      !item.enumerable || !("value" in item)
    )
  ) fail();
  return result;
}
/** Capture registration descriptors before public factories await persistence. */
export function captureActionPreparations(
  input: ActionPreparations,
): ActionPreparations {
  const top = properties(input, [
    "registrations",
    "source",
    "projectResource",
    "authorizeResource",
    "authorizeView",
    "maxPendingRenders",
    "renderTimeoutMs",
    "maxBytes",
  ]);
  const source = properties(top.source?.value, [
    "sources",
    "authorize",
    "projectRecord",
    "authorizeOriginal",
  ]);
  const raw = top.registrations?.value;
  const registered = properties(
    raw,
    raw && typeof raw === "object" ? Object.keys(raw) : [],
  );
  const registrations = Object.fromEntries(
    Object.entries(registered).map(([name, descriptor]) => {
      text(name);
      const value = properties(descriptor.value, [
        "source",
        "actionAlias",
        "shows",
        "modes",
        "resources",
        "mapInput",
      ]);
      if (typeof value.mapInput?.value !== "function") fail();
      const data = snapshot({
        source: value.source?.value,
        actionAlias: value.actionAlias?.value,
        shows: value.shows?.value,
        modes: value.modes?.value,
        resources: value.resources?.value ?? [],
      });
      return [name, { ...data as object, mapInput: value.mapInput.value }];
    }),
  );
  const callbacks = [
    source.authorize?.value,
    source.projectRecord?.value,
    source.authorizeOriginal?.value,
    top.projectResource?.value,
    top.authorizeResource?.value,
    top.authorizeView?.value,
  ];
  if (!callbacks.every((callback) => typeof callback === "function")) fail();
  const result = {
    registrations,
    source: {
      sources: snapshot(source.sources?.value),
      authorize: callbacks[0],
      projectRecord: callbacks[1],
      authorizeOriginal: callbacks[2],
    },
    projectResource: callbacks[3],
    authorizeResource: callbacks[4],
    authorizeView: callbacks[5],
    ...Object.fromEntries(
      ["maxPendingRenders", "renderTimeoutMs", "maxBytes"].flatMap((key) =>
        top[key] ? [[key, top[key].value]] : []
      ),
    ),
  } as ActionPreparations;
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(result);
  return result;
}
/** Internal constructor capture; the data-only worker surface never imports this. */
export function captureActionPreparationOptions<T extends object>(
  options: T,
): T {
  const descriptors: Record<string, PropertyDescriptor> = Object
    .getOwnPropertyDescriptors(options);
  const engine = descriptors.engine;
  if (engine) {
    if (!("value" in engine)) fail();
    if (engine.value !== undefined) {
      if (!engine.value || typeof engine.value !== "object") fail();
      const fields = Object.getOwnPropertyDescriptors(engine.value);
      if (fields.preparations) {
        if (!("value" in fields.preparations)) fail();
        if (fields.preparations.value !== undefined) {
          fields.preparations = {
            ...fields.preparations,
            value: captureActionPreparations(fields.preparations.value),
          };
        }
      }
      descriptors.engine = {
        ...engine,
        value: Object.defineProperties({}, fields),
      };
    }
  }
  return Object.defineProperties({}, descriptors) as T;
}
/** Capture descriptor values synchronously before any asynchronous digest/policy. */
export function compileActionPreparations(
  registry: PluginRegistry,
  input: ActionPreparations,
) {
  input = captureActionPreparations(input);
  const top = properties(input, [
    "registrations",
    "source",
    "projectResource",
    "authorizeResource",
    "authorizeView",
    "maxPendingRenders",
    "renderTimeoutMs",
    "maxBytes",
  ]);
  const source = top.source?.value;
  const sourceFields = properties(source, [
    "sources",
    "authorize",
    "projectRecord",
    "authorizeOriginal",
  ]);
  const sources = snapshot(
    sourceFields.sources?.value,
  ) as PreparationSourcePolicy["sources"];
  const policy: PreparationSourcePolicy = {
    sources,
    authorize: sourceFields.authorize?.value,
    projectRecord: sourceFields.projectRecord?.value,
    authorizeOriginal: sourceFields.authorizeOriginal?.value,
  };
  if (
    ![
      policy.authorize,
      policy.projectRecord,
      policy.authorizeOriginal,
      top.projectResource?.value,
      top.authorizeResource?.value,
      top.authorizeView?.value,
    ].every((value) => typeof value === "function")
  ) fail();
  const raw = top.registrations?.value;
  const definitions = properties(raw, Object.keys(raw ?? {}));
  const registrations = new Map(
    Object.entries(definitions).map(([name, descriptor]) => {
      text(name);
      const fields = properties(descriptor.value, [
        "source",
        "actionAlias",
        "shows",
        "modes",
        "resources",
        "mapInput",
      ]);
      const registration = snapshot({
        source: fields.source?.value,
        actionAlias: fields.actionAlias?.value,
        shows: fields.shows?.value,
        modes: fields.modes?.value,
        resources: fields.resources?.value ?? [],
      }) as Omit<ActionPreparationRegistration, "mapInput"> & {
        resources: readonly PreparationResourceCoordinate[];
      };
      const source = text(registration.source);
      const alias = text(registration.actionAlias);
      if (
        !Object.hasOwn(sources, source) ||
        !Object.hasOwn(registry.actions, alias)
      ) fail();
      viewShowsKey(registration.shows);
      if (
        !Array.isArray(registration.modes) || !registration.modes.length ||
        registration.modes.length > 32 ||
        new Set(registration.modes).size !== registration.modes.length
      ) fail();
      registration.modes.forEach(text);
      if (typeof fields.mapInput?.value !== "function") fail();
      return [name, {
        ...registration,
        actionId: text(registry.actions[alias].id),
        mapInput: fields.mapInput
          .value as ActionPreparationRegistration["mapInput"],
        resourcesRuntime: createPreparationResources({
          registry,
          resources: registration.resources,
          projectResource: top.projectResource.value,
          authorizeResource: top.authorizeResource.value,
          maxBytes: top.maxBytes?.value,
        }),
      }] as const;
    }),
  );
  const renderer = createPreparationRenderer({
    registry,
    maxPending: top.maxPendingRenders?.value,
    timeoutMs: top.renderTimeoutMs?.value,
    maxBytes: top.maxBytes?.value,
  });
  return {
    registrations,
    source: policy,
    renderer,
    authorizeView: top.authorizeView
      .value as ActionPreparations["authorizeView"],
    maxBytes: top.maxBytes?.value as number | undefined,
  };
}
export type CompiledActionPreparations = ReturnType<
  typeof compileActionPreparations
>;
export type NamedPreparationHooks = Readonly<{
  prepare(
    frame: ActionInvocationFrame,
    request: ActionNamedPreparation,
    operationKey?: string,
  ): Promise<Readonly<{ input: unknown; metadata: ActionInvocationMetadata }>>;
  authorize(
    frame: ActionInvocationFrame,
    purpose: PreparationPurpose,
    transaction?: SqlExecutor,
  ): Promise<void>;
}>;
type StoredPreparation = Readonly<{
  schema: typeof ACTION_PREPARATION_SCHEMA;
  binding: PreparationActionBinding;
  capture: ActionPreparationCapture;
  eventId: string;
  identity: Readonly<{ parentOperationKey: string; operationKey: string }>;
}>;
export function createNamedPreparations(
  options: Readonly<{
    compiled: CompiledActionPreparations;
    collectionPolicies?: CollectionPolicyRegistrations;
    registry: PluginRegistry;
    store: EventStore;
    coordinator: EventCoordinator;
    namespace: string;
    source: Readonly<{ eventId: string; operationId?: string }>;
    content: ContentResolver;
    inputContent?: Pick<
      RuntimeContent,
      "getMany" | "resolveMany" | "authorize"
    >;
    signal: AbortSignal;
    writer?: ActionWriter;
    operationCatalog?: Pick<OperationCatalog, "admitEventSql">;
    protectedValues?: ProtectedValueRuntime;
    lifecycleMetadata?: Readonly<Record<string, unknown>>;
    /** Read-time operation disclosure includes all captured descendant operations. */
    authorizeOperationResult?: boolean;
    prepareProtectedInput?(
      frame: ActionInvocationFrame,
      raw: unknown,
      transaction: SqlExecutor,
    ): Promise<{ input: unknown; claimed: boolean }> | undefined;
    authorizeProtected?(
      frame: ActionInvocationFrame,
      transaction: SqlExecutor,
    ): Promise<void>;
  }>,
): NamedPreparationHooks {
  const { store, namespace, compiled } = options;
  const run = createSchemaCommandRunner(store.session, store.databaseSchema);
  const source = createPreparationSource({
    schema: store.databaseSchema,
    registry: options.registry,
    policy: compiled.source,
    collectionPolicies: options.collectionPolicies,
    content: options.content,
    maxBytes: compiled.maxBytes,
  });
  const binding = (frame: ActionInvocationFrame): PreparationActionBinding => ({
    namespace,
    actionId: frame.actionId,
    actionRunId: frame.actionRunId,
    ...(frame.parentActionRunId
      ? { parentActionRunId: frame.parentActionRunId }
      : {}),
    sourceEventId: options.source.eventId,
    ...(options.source.operationId
      ? { operationId: options.source.operationId }
      : {}),
  });
  const context = (
    frame: ActionInvocationFrame,
    command: CommandContext,
    original = binding(frame),
  ) => ({
    tx: command.transaction,
    binding: structuredClone(original),
    commandTime: command.commandTime,
    signal: AbortSignal.any([options.signal, frame.signal, command.signal]),
  });
  const policyContext = async <T>(
    frame: ActionInvocationFrame,
    command: CommandContext,
    execute: (context: PreparationContext) => Promise<T>,
    original = binding(frame),
  ): Promise<T> => {
    const base = context(frame, command, original);
    let infrastructureFailed = false;
    const track = <V>(promise: Promise<V>): Promise<V> =>
      promise.catch((error) => {
        infrastructureFailed = true;
        throw error;
      });
    try {
      return await withOwnerAuthorizationPhase(() =>
        withOwnerQueryContext(
          ({ query, signal, commandTime }) => {
            const watchedQuery: typeof query = (sql, params) => {
              try {
                return track(query(sql, params));
              } catch (error) {
                infrastructureFailed = true;
                throw error;
              }
            };
            return execute({
              ...base,
              tx: { query: watchedQuery },
              signal,
              commandTime,
              resolveSource: () =>
                track(resolveProtectedActionSource({
                  transaction: { query: watchedQuery },
                  databaseSchema: store.databaseSchema,
                  namespace,
                  source: {
                    eventId: original.sourceEventId,
                    ...(original.operationId
                      ? { operationId: original.operationId }
                      : {}),
                  },
                  protectedValues: options.protectedValues,
                })),
            });
          },
          command,
          base.signal,
          () => ({}),
        )
      );
    } catch (error) {
      if (infrastructureFailed) {
        throw new Error("Preparation authorization could not be completed.");
      }
      return withOwnerPolicyRefusal(() => {
        throw error;
      }, base.signal);
    }
  };
  async function authority(frame: ActionInvocationFrame, tx: SqlExecutor) {
    options.signal.throwIfAborted();
    frame.signal.throwIfAborted();
    if (options.writer) {
      if (options.writer.kind !== "delivery") fail("preparation_forbidden");
      if (!options.operationCatalog) fail("preparation_authority_missing");
      await assertOwnerInvocationLive(
        schemaCommandContext(tx, store.databaseSchema),
        {
          databaseSchema: store.databaseSchema,
          namespace,
          operationCatalog: options.operationCatalog,
          operationId: options.source.operationId,
          eventId: options.source.eventId,
          writer: options.writer,
        },
      );
    }
    const event = await tx.query(
      `SELECT id FROM ${store.tables.events} WHERE id=$1 AND namespace=$2`,
      [options.source.eventId, namespace],
    );
    if (event.rows.length !== 1) fail("preparation_source_missing");
  }
  async function invoked(tx: SqlExecutor, actionRunId: string) {
    const event = (await tx.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM ${store.tables.events} WHERE namespace=$1 AND deduplication_id=$2`,
      [namespace, `${actionRunId}:action:invoked`],
    )).rows[0];
    if (!event) return;
    const body = await readEventBody(
      { transaction: tx, tables: store.tables },
      namespace,
      eventDataRef(event.payload),
    );
    const data = publicActionLifecycleData(body) as ActionEventData;
    if (data.status !== "invoked" || data.actionRunId !== actionRunId) {
      fail("preparation_capture_invalid");
    }
    return { event, body, data };
  }
  async function read(
    tx: SqlExecutor,
    frame: Pick<
      ActionInvocationFrame,
      "actionRunId" | "actionId" | "parentActionRunId"
    >,
    expectedKey?: string,
    descendant = false,
  ) {
    const admitted = await invoked(tx, frame.actionRunId);
    const receiptKey = expectedKey ?? admitted?.data.metadata[MARKER];
    if (receiptKey === undefined) return;
    if (typeof receiptKey !== "string") fail("preparation_capture_invalid");
    const rows = await tx.query<{ intent: unknown; result: unknown }>(
      `SELECT intent,result FROM ${store.tables.owner_receipts} WHERE owner='schema' AND domain='logical' AND key=$1 AND kind=$2`,
      [receiptKey, KIND],
    );
    if (!rows.rows.length) {
      const history = await invoked(tx, frame.actionRunId);
      if (history && Object.hasOwn(history.data.metadata, MARKER)) {
        fail("preparation_capture_orphan");
      }
      return;
    }
    const raw = snapshot(rows.rows[0].result) as unknown as StoredPreparation;
    if (
      !raw ||
      Object.keys(raw).sort().join(",") !==
        "binding,capture,eventId,identity,schema" ||
      raw.schema !== ACTION_PREPARATION_SCHEMA || !raw.binding ||
      raw.binding.namespace !== namespace ||
      raw.binding.actionRunId !== frame.actionRunId ||
      raw.binding.actionId !== frame.actionId ||
      raw.binding.parentActionRunId !== frame.parentActionRunId
    ) fail("preparation_capture_invalid");
    if (
      !raw.identity ||
      Object.keys(raw.identity).sort().join(",") !==
        "operationKey,parentOperationKey" ||
      preparationReceiptKey(
          namespace,
          text(raw.identity.parentOperationKey),
          text(raw.identity.operationKey),
        ) !== receiptKey
    ) fail("preparation_capture_invalid");
    const bindingKeys = Object.keys(raw.binding);
    if (
      bindingKeys.some((key) =>
        ![
          "namespace",
          "actionId",
          "actionRunId",
          "parentActionRunId",
          "sourceEventId",
          "operationId",
        ].includes(key)
      )
    ) fail("preparation_capture_invalid");
    text(raw.binding.sourceEventId);
    const capture = parseActionPreparationCapture(raw.capture);
    const history = await invoked(tx, frame.actionRunId);
    if (!history || text(raw.eventId) !== history.event.id) {
      fail("preparation_capture_orphan");
    }
    const { data, body } = history;
    if (
      data.actionId !== frame.actionId ||
      data.parentActionRunId !== frame.parentActionRunId ||
      data.metadata[MARKER] !== receiptKey
    ) fail("preparation_capture_invalid");
    if (
      data.metadata[INTEGRITY] !==
        await preparationIntegrity({
          binding: raw.binding,
          capture,
          identity: raw.identity,
          intent: rows.rows[0].intent,
        })
    ) fail("preparation_capture_invalid");
    const original = {
      eventId: raw.binding.sourceEventId,
      ...(raw.binding.operationId
        ? { operationId: raw.binding.operationId }
        : {}),
    };
    await assertProtectedActionSourceReplay({
      transaction: tx,
      databaseSchema: store.databaseSchema,
      namespace,
      original: descendant ? options.source : original,
      current: descendant ? original : options.source,
    });
    return { intent: rows.rows[0].intent, stored: { ...raw, capture }, body };
  }
  async function check(
    frame: ActionInvocationFrame,
    captured: StoredPreparation,
    command: CommandContext,
    purpose: PreparationPurpose,
  ) {
    const registration = compiled.registrations.get(
      captured.capture.preparation,
    );
    if (
      !registration || registration.actionId !== captured.binding.actionId ||
      registration.source !== captured.capture.source.source.name ||
      !registration.modes.includes(captured.capture.view.hints.mode) ||
      canonical(registration.shows) !== canonical(captured.capture.view.shows)
    ) refuse("preparation_forbidden");
    await policyContext(frame, command, async (policy) => {
      await source.authorizeOriginal(captured.capture.source, policy, purpose);
      const view = captured.capture.view;
      if (view.selection.kind === "registered") {
        const original = Object.values(options.registry.views).find(
          (candidate) => candidate.id === (view.selection as { id: string }).id,
        );
        if (
          !original || canonical(original.shows) !== canonical(view.shows) ||
          original.renderer !== "text" ||
          !original.modes.includes(view.hints.mode)
        ) refuse("preparation_view_forbidden");
      }
      if (
        await compiled.authorizeView(policy.tx, {
          binding: policy.binding,
          view: structuredClone(view),
          purpose,
          commandTime: policy.commandTime,
          resolveSource: policy.resolveSource,
          signal: policy.signal,
        }) !== true
      ) refuse("preparation_view_forbidden");
      await registration.resourcesRuntime.authorize(
        policy.tx,
        captured.capture.resources,
        {
          binding: policy.binding,
          scope: { namespace, audience: captured.capture.source.audience },
          commandTime: policy.commandTime,
          resolveSource: policy.resolveSource,
          signal: policy.signal,
        },
        purpose,
      );
    }, captured.binding);
    await authority(frame, command.transaction);
  }
  const authorize: NamedPreparationHooks["authorize"] = async (
    frame,
    purpose,
    transaction,
  ) => {
    const execute = async (command: CommandContext) => {
      await authority(frame, command.transaction);
      // Walk only persisted Action parents and operation ancestry. Metadata is a
      // corruption cue, never an edge or authority supplied by a worker.
      const queue: Array<
        Pick<
          ActionInvocationFrame,
          "actionRunId" | "actionId" | "parentActionRunId"
        >
      > = [frame];
      const seen = new Set<string>();
      const descendantRuns = new Set<string>();
      if (purpose === "result") {
        // A parent result may contain a prepared child's bytes. Retained Action
        // parent links, not worker metadata, conservatively carry that policy.
        for (
          const run of await preparationActionDescendants(
            command.transaction,
            store.tables.event_bodies,
            namespace,
            frame.actionRunId,
          )
        ) {
          const history = await invoked(command.transaction, run);
          if (!history) fail("preparation_capture_orphan");
          queue.push(history.data);
          descendantRuns.add(run);
        }
      }
      const operationTable =
        createOperationCatalogTables(store.databaseSchema).operations;
      if (
        purpose === "result" && options.authorizeOperationResult &&
        options.source.operationId
      ) {
        for (
          const run of await preparationOperationDescendants(
            command.transaction,
            {
              operations: operationTable,
              receipts: store.tables.owner_receipts,
            },
            namespace,
            options.source.operationId,
          )
        ) {
          const history = await invoked(command.transaction, run);
          if (!history) fail("preparation_capture_orphan");
          queue.push(history.data);
          descendantRuns.add(run);
        }
      }
      let operationId = options.source.operationId;
      const operations = new Set<string>();
      while (operationId) {
        if (operations.has(operationId) || operations.size >= 64) {
          fail("preparation_capture_invalid");
        }
        operations.add(operationId);
        const edge = (await command.transaction.query<
          {
            parent_operation_id: string | null;
            parent_action_run_id: string | null;
          }
        >(
          `SELECT parent_operation_id,parent_action_run_id FROM ${operationTable} WHERE namespace=$1 AND operation_id=$2`,
          [namespace, operationId],
        )).rows[0];
        if (
          !edge ||
          Boolean(edge.parent_operation_id) !==
            Boolean(edge.parent_action_run_id)
        ) fail("preparation_capture_invalid");
        if (edge.parent_action_run_id) {
          const parent = await invoked(
            command.transaction,
            edge.parent_action_run_id,
          );
          if (!parent) fail("preparation_capture_orphan");
          queue.push(parent.data);
        }
        operationId = edge.parent_operation_id ?? undefined;
      }
      while (queue.length) {
        const current = queue.shift()!;
        if (seen.has(current.actionRunId)) continue;
        if (seen.size >= 64) fail("preparation_capture_invalid");
        seen.add(current.actionRunId);
        const captured = await read(
          command.transaction,
          current,
          undefined,
          descendantRuns.has(current.actionRunId),
        );
        if (captured) await check(frame, captured.stored, command, purpose);
        else if (current === frame && Object.hasOwn(frame.metadata, MARKER)) {
          fail("preparation_capture_orphan");
        }
        if (current.parentActionRunId) {
          const parent = await invoked(
            command.transaction,
            current.parentActionRunId,
          );
          if (!parent) fail("preparation_capture_orphan");
          queue.push(parent.data);
        }
      }
      await options.authorizeProtected?.(frame, command.transaction);
    };
    if (transaction) {
      await execute(schemaCommandContext(transaction, store.databaseSchema));
    } else {await run("actions.authorizePreparation", {
        actionRunId: frame.actionRunId,
        purpose,
      }, async (_input, command) => await execute(command));}
  };
  return {
    authorize,
    async prepare(frame, rawRequest, operationKey = frame.operationKey) {
      const normalized = normalizeActionNamedPreparation(rawRequest, {
        operationKey,
      });
      const request = normalized.request;
      const identity = {
        parentOperationKey: frame.parentActionRunId ?? frame.rootKey,
        operationKey: normalized.operationKey,
      };
      const receiptKey = preparationReceiptKey(
        namespace,
        identity.parentOperationKey,
        identity.operationKey,
      );
      const registration = compiled.registrations.get(request.preparation);
      if (!registration || registration.actionId !== frame.actionId) {
        fail("preparation_forbidden");
      }
      if (!registration.modes.includes(request.mode)) {
        fail("preparation_renderer_unavailable");
      }
      const intent = await actionPreparationIntent({
        preparation: request.preparation,
        ...identity,
        source: registration.source,
        recordId: request.recordId,
        actionId: frame.actionId,
        hints: { mode: request.mode, renderer: "text" },
      });
      const metadata: Record<string, string> = { [MARKER]: receiptKey };
      const capturedFrame = inheritActionInvocationParent(frame, {
        ...frame,
        metadata,
      });
      return await run(
        KIND,
        { actionRunId: frame.actionRunId },
        async (_input, command) => {
          await authority(capturedFrame, command.transaction);
          const admitted =
            (await command.transaction.query<{ intent: unknown }>(
              `SELECT intent FROM ${store.tables.owner_receipts} WHERE owner='schema' AND domain='logical' AND kind=$1 AND key=$2`,
              [KIND, receiptKey],
            )).rows[0];
          if (
            admitted && canonical(admitted.intent) !== canonical(intent)
          ) fail("owner_intent_conflict");
          const prior = await read(
            command.transaction,
            capturedFrame,
            receiptKey,
          );
          if (prior) {
            if (canonical(prior.intent) !== canonical(intent)) {
              fail(
                "owner_intent_conflict",
              );
            }
            await check(capturedFrame, prior.stored, command, "duplicate");
            await options.authorizeProtected?.(
              capturedFrame,
              command.transaction,
            );
            const data = await hydrateActionLifecycleBody({
              namespace,
              body: prior.body as ActionEventData,
              action: actionDefinitionById(
                options.registry.actions,
                frame.actionId,
              ),
              protectedValues: options.protectedValues,
              transaction: command.transaction,
            });
            return { input: data.input, metadata: data.metadata };
          }
          const existing = await command.transaction.query(
            `SELECT id FROM ${store.tables.events} WHERE namespace=$1 AND deduplication_id=$2`,
            [namespace, `${frame.actionRunId}:action:invoked`],
          );
          if (existing.rows.length) fail("preparation_capture_orphan");
          const ctx = context(capturedFrame, command);
          const selected = await policyContext(
            capturedFrame,
            command,
            (policy) =>
              source.capture({
                source: registration.source,
                recordId: request.recordId,
              }, policy),
          );
          const scope = { namespace, audience: selected.reference.audience };
          const resources = await policyContext(
            capturedFrame,
            command,
            (policy) =>
              registration.resourcesRuntime.capture(policy.tx, {
                binding: policy.binding,
                scope,
                commandTime: policy.commandTime,
                resolveSource: policy.resolveSource,
                signal: policy.signal,
              }),
          );
          const rendered = await compiled.renderer.render({
            shows: registration.shows,
            hints: { mode: request.mode, renderer: "text" },
            data: selected.projection,
            resources: resources.values,
            scope,
            signal: ctx.signal,
            mapInput: async (text, input) => {
              const mapped = snapshot(
                await registration.mapInput(text, input),
                compiled.maxBytes,
              );
              assertPreparationProjection(mapped);
              return mapped;
            },
          });
          const capture = parseActionPreparationCapture({
            schema: ACTION_PREPARATION_SCHEMA,
            preparation: request.preparation,
            source: selected.reference,
            resources: resources.references,
            view: {
              shows: registration.shows,
              hints: rendered.hints,
              selection: rendered.selection,
            },
          });
          metadata[INTEGRITY] = await preparationIntegrity({
            binding: binding(capturedFrame),
            capture,
            identity,
            intent,
          });
          const protectedInput = await options.prepareProtectedInput?.(
            capturedFrame,
            rendered.input,
            command.transaction,
          );
          let input: unknown = protectedInput?.input ?? rendered.input;
          const definition = actionDefinitionById(
            options.registry.actions,
            frame.actionId,
          );
          let validationInput: unknown = input;
          if (definition.content) {
            if (!options.inputContent) fail("preparation_content_unavailable");
            const prepared = await prepareActionContentInput(
              input,
              actionContentDeclaration(definition.content),
              options.inputContent,
              ctx.signal,
            );
            input = prepared.durableInput;
            validationInput = await prepared.hydrate();
          }
          if (definition.inputSchema) {
            validateAgainstJsonSchema(
              definition.inputSchema,
              validationInput,
              `Action '${definition.id}' input`,
            );
          }
          if (!protectedInput?.claimed) {
            const emitter = createActionLifecycleEmitter({
              namespace,
              metadata: options.lifecycleMetadata,
              append: createActionLifecycleAppender({
                store,
                coordinator: options.coordinator,
                actions: options.registry.actions,
                protectedValues: options.protectedValues,
                writer: options.writer,
                transaction: command.transaction,
              }),
            });
            await emitter.emit({
              status: "invoked",
              actionRunId: frame.actionRunId,
              actionId: frame.actionId,
              ...(frame.parentActionRunId
                ? { parentActionRunId: frame.parentActionRunId }
                : {}),
              metadata,
              input,
              effectProtocol: 1,
              ...frame.identity,
              deduplicationId: `${frame.actionRunId}:action:invoked`,
            });
          }
          const event = (await command.transaction.query<{ id: string }>(
            `SELECT id FROM ${store.tables.events} WHERE namespace=$1 AND deduplication_id=$2`,
            [namespace, `${frame.actionRunId}:action:invoked`],
          )).rows[0];
          if (!event) fail("preparation_capture_orphan");
          const stored: StoredPreparation = {
            schema: ACTION_PREPARATION_SCHEMA,
            binding: binding(capturedFrame),
            capture,
            eventId: event.id,
            identity,
          };
          await check(capturedFrame, stored, command, "capture");
          await check(capturedFrame, stored, command, "claim");
          await command.transaction.query(
            `INSERT INTO ${store.tables.owner_receipts} (owner,domain,key,principal,kind,intent,result) VALUES ('schema','logical',$1,'runtime',$2,$3::jsonb,$4::jsonb)`,
            [receiptKey, KIND, JSON.stringify(intent), JSON.stringify(stored)],
          );
          return { input, metadata };
        },
      );
    },
  };
}
