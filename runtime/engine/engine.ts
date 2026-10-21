import { retainedAuthority } from "../authorization/authority.ts";
import { createDirectoryReader } from "../authorization/directory-read.ts";
import {
  hostIngressProof,
  ownerIngressEvidence,
} from "../application/ingress/authority.ts";
import {
  authorizationRefused,
  captureOwnerAuthorization,
  collectionAuthorizations,
} from "../authorization/evaluator.ts";
import { sameActionValue } from "../actions/value.ts";
import { durableActionContentInput } from "../actions/content.ts";
import {
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  SERVER_COLLECTION_MUTATION_RELAY_CONSUMER,
} from "../application/ingress/contracts.ts";
import { awaitEventPublication } from "../events/coordinator.ts";
import { assertOwnerInvocationLive } from "./invocation-liveness.ts";
import { canRecoverCollectionReceipt } from "../collections/receipt-authority.ts";
import {
  resolveProtectedActionIngress,
  resolveProtectedActionSource,
} from "../actions/protected-action-source.ts";
import { settleActionAuthorizationRefusal } from "../actions/authorization-refusal.ts";
import { createAuthorizedActions } from "../actions/authorized-capture.ts";
import { createOwnerEffectClient } from "../actions/effect-commands.ts";
import {
  createDeliveryWorkload,
  type OwnerExecutionOptions,
} from "../execution/workload.ts";
import {
  createSchemaCommandRunner,
  readSchemaReceipt,
} from "../engine/commands.ts";
import {
  type DatabaseOwner,
  openDatabaseOwner,
  pauseFinalDatabaseOwnerAlarms,
  releaseDatabaseOwner,
} from "./commands.ts";
import { deriveWorkflowId } from "../events/workflow-id.ts";
import {
  admitActionOperation,
  prepareActionOperation,
} from "../actions/continuation-work.ts";
import { scheduleResumptions } from "../actions/continuation-work.ts";
import { executeActionContinuation } from "../actions/resume.ts";
import {
  provisionCollectionIndexes,
  validateCollectionIndexes,
} from "../collections/indexes.ts";
import { isStreamOutputDescriptor } from "../streams/index.ts";
import {
  createActionLifecycleAppender,
  createActionLifecycleEmitter,
  createActionLifecycleLoader,
} from "../actions/index.ts";
import {
  actionDefinitionById,
  actionDefinitionHasSecrets,
} from "../actions/protected-lifecycle.ts";
import { createSecretAdapter } from "../actions/secret-adapter.ts";
import { openProtectedEventBody } from "../actions/protected-event.ts";
import {
  assetBodySchemaPrefix,
  createBodyStorageRuntime,
  createContentPreparer,
} from "../content/index.ts";
import {
  type CopilotzEvent,
  type CopilotzEventHub,
  createCopilotzEventHub,
  createEventStore,
  type EventStore,
  provisionCopilotzSchema,
  validateCopilotzSchema,
} from "../events/index.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import {
  createDeliveryExecutor,
  type DeliveryContextBase,
  type DeliveryExecutor,
  invokeLiveProcessors,
  type LiveEventDispatchHandle,
  type LiveProcessorContextBase,
} from "../execution/index.ts";
import { reportDeliveryDiagnostic } from "../execution/diagnostics.ts";
import {
  createTransientProcessorSet,
  type Processor,
  type ProcessorContext,
  resolveProcessorEvent,
} from "../plugins/index.ts";
import { createProcessorContext } from "./context.ts";
import {
  createDatabaseScope,
  type DatabaseScopeRuntime,
} from "./database-scope.ts";
import type {
  CopilotzEngine,
  CreateCopilotzEngineOptions,
  EngineContextSeed,
} from "./types.ts";
import {
  createOperationCatalog,
  createOperationCatalogTables,
  provisionOperationCatalog,
  validateOperationCatalog,
} from "../streams/catalog.ts";

type AdditionalDatabaseScope = Readonly<{
  runtime: DatabaseScopeRuntime;
  hub: CopilotzEventHub;
}>;

async function prepareDefaultDatabaseSchema(
  options: CreateCopilotzEngineOptions,
  schema: string,
): Promise<void> {
  if (options.provisionDefaultDatabaseSchema === false) {
    await validateCopilotzSchema(options.session, schema);
    return;
  }
  await provisionCopilotzSchema(options.session, schema);
}

/** Composes the event-native Copilotz core without taking session ownership. */
export async function createCopilotzEngine(
  options: CreateCopilotzEngineOptions,
  construction: Readonly<{
    /** Package composition installs local handlers before owner activation. */
    ownerAcquired?(schema: string, owner: DatabaseOwner): void;
    /** Install transport admission before recovery can publish dispatches. */
    beforeRecovery?(engine: CopilotzEngine): void | Promise<void>;
  }> = {},
): Promise<CopilotzEngine> {
  if (
    ["collectionPolicies", "protectedActions"].some((key) =>
      Object.hasOwn(options, key)
    )
  ) {
    throw new TypeError(
      "Use the owner authorization registry; removed authorization registrations are forbidden.",
    );
  }
  const databaseSchema = options.defaultDatabaseSchema ?? "public";
  options = {
    ...options,
    authorization: captureOwnerAuthorization(
      options.authorization,
      options.registry.collections,
      options.registry.actions,
    ),
  };
  const collectionPolicyRegistrations = collectionAuthorizations(
    options.authorization,
    options.registry.collections,
    databaseSchema,
  );
  const configuredSecretAdapter = options.secretAdapter ??
    options.registry.adapters.secrets?.default;
  const secretAdapter = configuredSecretAdapter === undefined
    ? undefined
    : createSecretAdapter(configuredSecretAdapter as never);
  const requiresSecrets = Object.values(options.registry.actions).some(
    actionDefinitionHasSecrets,
  );
  if (requiresSecrets && !secretAdapter) {
    throw new TypeError(
      "Actions with x-copilotz-secret schemas require adapters.secrets.default.",
    );
  }
  const engineOptions: CreateCopilotzEngineOptions = {
    ...options,
    assetStorage: options.assetStorage ??
      createBodyStorageRuntime(options.assets),
    ...(secretAdapter ? { secretAdapter } : {}),
  } as const;
  await prepareDefaultDatabaseSchema(options, databaseSchema);
  const owner = await openDatabaseOwner(options.session, databaseSchema, {
    now: options.now,
    alarmScheduler: options.alarmScheduler,
  });
  try {
    construction.ownerAcquired?.(databaseSchema, owner);
    if (options.provisionDefaultDatabaseSchema === false) {
      await validateOperationCatalog(options.session, databaseSchema);
    } else {
      await provisionOperationCatalog(options.session, databaseSchema);
    }
    const definitions = Object.values(options.registry.collections);
    if (options.provisionDefaultDatabaseSchema === false) {
      await validateCollectionIndexes(
        options.session,
        databaseSchema,
        definitions,
      );
    } else {
      await provisionCollectionIndexes(
        options.session,
        databaseSchema,
        definitions,
      );
    }
    const operationCatalog = createOperationCatalog(
      options.session,
      databaseSchema,
      {
        onSettled: async (transaction, input) =>
          primaryRuntime!.deferPublication(
            await scheduleResumptions(
              { store, coordinator: primaryRuntime!.coordinator },
              input,
              transaction,
            ),
          ),
        onStreamTerminal: ({ namespace, operationId }) => {
          // A terminal body may arrive after its delivery has settled. Wake the
          // generic owner outside the writer/relay's own completion promise.
          void operationCatalog.reconcile({ namespace, operationId }).catch(
            () => undefined,
          );
        },
        beforeTerminal: ({ namespace, operationId }) =>
          executor.settleOutputs({
            databaseSchema,
            namespace,
            settlementScopeId: operationId,
          }),
      },
    );
    const now = options.now ?? (() => new Date());
    const eventHub = options.eventHub ?? createCopilotzEventHub();
    const ownsEventHub = options.eventHub === undefined;

    const configuredTransients = () =>
      createTransientProcessorSet(
        (options.transientProcessors ?? []) as readonly Processor[],
      );
    const transientsBySchema = new Map<
      string,
      ReturnType<typeof createTransientProcessorSet>
    >();
    const transients = configuredTransients();
    transientsBySchema.set(databaseSchema, transients);
    const transientsFor = (schema: string) => {
      const scoped = transientsBySchema.get(schema);
      if (!scoped) {
        throw new Error(
          `Transient processors for schema '${schema}' are not initialized.`,
        );
      }
      return scoped;
    };
    const store: EventStore = createEventStore({
      session: options.session,
      schema: databaseSchema,
      createId: options.createId,
      now,
      random: options.random,
      leaseMs: options.leaseMs,
      maxAttempts: options.maxAttempts,
      retryBaseMs: options.retryBaseMs,
      retryCapMs: options.retryCapMs,
      onScopeCancellation: (transaction, input) => {
        if (!primaryRuntime) throw new Error("Runtime is not initialized.");
        return primaryRuntime.onScopeCancellation(transaction, input);
      },
      settleActionOwners: (transaction, delivery) => {
        if (!primaryRuntime) {
          throw new Error("Primary runtime is not initialized.");
        }
        return primaryRuntime.settleActionOwners(transaction, delivery);
      },
      admitOperationEventSql: (input, param) =>
        operationCatalog.admitEventSql(input, param),
      indexOperationEvent: (transaction, input) =>
        operationCatalog.indexEvent(transaction, input),
      indexOperationEventSql: (input, param) =>
        operationCatalog.indexEventSql(input, param),
    });
    const additionalScopes = new Map<
      string,
      Promise<AdditionalDatabaseScope>
    >();
    const relayedDurableIds = new Set<string>();
    const relayedDurableOrder: string[] = [];
    let closed = false;
    let shutdownPromise: Promise<void> | undefined;
    let resolveAdditionalScope: (
      databaseSchema: string,
    ) => Promise<AdditionalDatabaseScope>;

    let capabilities: DatabaseScopeRuntime["capabilities"] | undefined;
    let primaryRuntime: DatabaseScopeRuntime | undefined;
    const preparer = createContentPreparer({
      createId: options.createId,
      digest: options.digest,
    });
    let resolver:
      | DatabaseScopeRuntime["public"]["content"]["resolver"]
      | undefined;
    const resolveEventInScope = async (
      event: CopilotzEvent,
      requestedDatabaseSchema: string,
    ) => {
      const additional = requestedDatabaseSchema === databaseSchema
        ? undefined
        : await resolveAdditionalScope(requestedDatabaseSchema);
      const scopedResolver = additional?.runtime.public.content.resolver ??
        resolver;
      if (!scopedResolver) {
        throw new Error("Copilotz event content resolver is not initialized.");
      }
      return await resolveProcessorEvent(
        additional?.runtime.store ?? store,
        event,
        scopedResolver,
      );
    };
    const createContextFor = async (
      base: EngineContextSeed,
      actionResumption?:
        import("../actions/invoker.ts").CreateActionCallersOptions[
          "resumption"
        ],
      execution?: OwnerExecutionOptions,
    ): Promise<ProcessorContext> => {
      const additional = base.databaseSchema === databaseSchema
        ? undefined
        : await resolveAdditionalScope(base.databaseSchema);
      const scopedOwner = additional?.runtime.owner ?? owner;
      base = {
        ...base,
        signal: AbortSignal.any([base.signal, scopedOwner.signal]),
      };
      const scopedCapabilities = additional?.runtime.capabilities ??
        capabilities;
      const scopedResolver = additional?.runtime.public.content.resolver ??
        resolver;
      const scopedEventHub = additional?.hub ?? eventHub;
      const scopedStore = additional?.runtime.store ?? store;
      const scopedOperationCatalog = additional?.runtime.operationCatalog ??
        operationCatalog;
      const scopedCoordinator = additional?.runtime.coordinator ??
        primaryRuntime?.coordinator;
      if (!scopedCapabilities || !scopedResolver) {
        throw new Error("Copilotz engine context is not initialized.");
      }
      if (!scopedCoordinator) {
        throw new Error("Copilotz action lifecycle is not initialized.");
      }
      const authorizedActions = createAuthorizedActions({
        authorization: options.authorization,
        collections: options.registry.collections,
        actions: (execution?.registry ?? options.registry).actions,
        store: scopedStore,
        coordinator: scopedCoordinator,
        operationCatalog: scopedOperationCatalog,
        namespace: base.event.namespace,
        signal: base.signal,
        protectedValues: scopedCapabilities.protectedValues,
        ...(base.event.durable
          ? {
            source: {
              eventId: base.event.id,
              ...(base.settlementScopeId
                ? { operationId: base.settlementScopeId }
                : {}),
            },
          }
          : {}),
        ...(base.source?.kind === "delivery" && base.executionIncarnationId
          ? {
            writer: {
              kind: "delivery" as const,
              deliveryId: base.source.id,
              leaseOwner: base.executionIncarnationId,
            },
          }
          : {}),
        lifecycleMetadata: {
          ...(base.event.durable ? { sourceEventId: base.event.id } : {}),
          ...(base.source?.kind === "delivery"
            ? {
              sourceDeliveryId: base.source.id,
              ...(base.source.consumerId
                ? { sourceConsumerId: base.source.consumerId }
                : {}),
            }
            : {}),
        },
      });
      // Resolve immutable ingress once per execution; each command still checks
      // live authority and invocation ownership before using it.
      const invocationIngress = base.event.durable
        ? base.event.ownerIngress ?? await resolveProtectedActionIngress({
          transaction: scopedStore.session,
          databaseSchema: base.databaseSchema,
          namespace: base.event.namespace,
          source: {
            eventId: base.event.id,
            ...(base.settlementScopeId
              ? { operationId: base.settlementScopeId }
              : {}),
          },
        })
        : undefined;
      // Public Processor Events must not share mutable authority with the binding.
      const invocationAuthority = invocationIngress?.authority
        ? retainedAuthority(invocationIngress.authority)
        : undefined;
      return createProcessorContext({
        directory: createDirectoryReader({
          session: scopedStore.session,
          databaseSchema: base.databaseSchema,
          registration: options.authorization,
          collections: options.registry.collections,
          actions: options.registry.actions,
        }),
        collectionInvocation: {
          owner: {
            ...(invocationAuthority ? { authority: invocationAuthority } : {}),
            trustedHost: !invocationAuthority &&
              invocationIngress?.kind === "host",
            // The Server relay applies a client's own HTTP mutation: policies
            // see a direct call, never an executing Processor grant.
            direct: base.source?.consumerId ===
              SERVER_COLLECTION_MUTATION_RELAY_CONSUMER,
            logicalRunId: base.idempotencyKey,
            operationId: base.settlementScopeId,
            scope: {
              databaseSchema: base.databaseSchema,
              namespace: base.event.namespace,
            },
            signal: base.signal,
            assertCurrent: (read, invocation) =>
              assertOwnerInvocationLive(read, {
                databaseSchema: base.databaseSchema,
                namespace: base.event.namespace,
                operationCatalog: scopedOperationCatalog,
                operationId: base.settlementScopeId,
                ...(base.event.durable ? { eventId: base.event.id } : {}),
                ...(base.source?.kind === "delivery" &&
                    base.executionIncarnationId
                  ? {
                    writer: {
                      deliveryId: base.source.id,
                      leaseOwner: base.executionIncarnationId,
                    },
                  }
                  : {}),
                ...(invocation.kind === "action"
                  ? { action: { id: invocation.id, runId: invocation.runId } }
                  : {}),
              }),
            resolveSource: (transaction) => {
              if (!base.event.durable) {
                throw new Error("Collection policy source is not durable.");
              }
              return resolveProtectedActionSource({
                transaction,
                databaseSchema: base.databaseSchema,
                namespace: base.event.namespace,
                source: {
                  eventId: base.event.id,
                  ...(base.settlementScopeId
                    ? { operationId: base.settlementScopeId }
                    : {}),
                },
                protectedValues: scopedCapabilities.protectedValues,
              });
            },
          },
          invocation: {
            kind: "processor",
            id: base.source?.consumerId?.replace(/^processor:/, "") ??
              "runtime",
            runId: base.executionIncarnationId ?? base.idempotencyKey,
          },
        },
        authorizeAction:
          Object.keys(options.authorization?.actions ?? {}).length
            ? async (frame, _purpose, transaction) => {
              const authorize = authorizedActions.output(frame).authorize;
              if (!authorize) return;
              if (transaction) await authorize(transaction);
              else {
                await createSchemaCommandRunner(
                  scopedStore.session,
                  scopedStore.databaseSchema,
                )(
                  "actions.authorizeInput",
                  { actionRunId: frame.actionRunId },
                  async (_input, command) =>
                    await authorize(command.transaction),
                );
              }
            }
            : undefined,
        prepareActionInput: async (frame, input) => {
          const protectedInput = authorizedActions.prepareInput(frame, input);
          if (protectedInput) return await protectedInput;
          if (
            frame.parentActionRunId ||
            base.event.type !== SERVER_ACTION_REQUEST_EVENT_TYPE ||
            base.source?.kind !== "delivery" || !base.executionIncarnationId ||
            !base.event.durable
          ) return;
          const claim = await scopedStore.readLocalClaim(
            base.source.id,
            base.executionIncarnationId,
          ) ??
            await scopedStore.readRemoteClaim(
              base.source.id,
              base.executionIncarnationId,
            );
          if (!claim) return;
          const action = actionDefinitionById(
            options.registry.actions,
            frame.actionId,
          );
          const invoked = await createActionLifecycleLoader({
            store: scopedStore,
            actions: options.registry.actions,
            protectedValues: scopedCapabilities.protectedValues,
          })(base.event.namespace, `${frame.actionRunId}:action:invoked`);
          if (!invoked) return;
          if (
            invoked.status !== "invoked" || invoked.parentActionRunId ||
            invoked.actionId !== frame.actionId ||
            !sameActionValue(
              invoked.input,
              action.content
                ? durableActionContentInput(input, action.content)
                : input,
            ) ||
            !sameActionValue(invoked.metadata, frame.metadata)
          ) throw new TypeError("Admitted Action differs from its invocation.");
          return { input, claimed: claim.attempts === 1 };
        },
        refuseActionAuthorization: base.event.durable
          ? (frame) =>
            settleActionAuthorizationRefusal({
              store: scopedStore,
              coordinator: scopedCoordinator,
              namespace: base.event.namespace,
              source: {
                eventId: base.event.durable ? base.event.id : "",
                ...(base.settlementScopeId
                  ? { operationId: base.settlementScopeId }
                  : {}),
              },
              ...(base.source?.kind === "delivery" &&
                  base.executionIncarnationId
                ? {
                  writer: {
                    kind: "delivery" as const,
                    deliveryId: base.source.id,
                    leaseOwner: base.executionIncarnationId,
                  },
                }
                : {}),
              actions: (execution?.registry ?? options.registry).actions,
              protectedValues: scopedCapabilities.protectedValues,
            }, frame)
          : undefined,
        createEffectClient: (frame) =>
          createOwnerEffectClient({
            session: scopedStore.session,
            schema: base.databaseSchema,
            namespace: base.event.namespace,
            actionRunId: frame.actionRunId,
            action: actionDefinitionById(
              (execution?.registry ?? options.registry).actions,
              frame.actionId,
            ),
            authorize: authorizedActions.output(frame).authorize,
            verifyNotStarted: (_transaction, reference, evidence) => {
              frame.signal.throwIfAborted();
              return options.verifyEffectNotStarted?.(
                { databaseSchema: base.databaseSchema, ...reference },
                evidence,
                { signal: frame.signal },
              ) ?? false;
            },
            signal: frame.signal,
            ...(base.source?.kind === "delivery" && base.executionIncarnationId
              ? {
                writer: {
                  deliveryId: base.source.id,
                  leaseOwner: base.executionIncarnationId,
                },
              }
              : {}),
          }),
        operations: {
          async start(input) {
            base.signal.throwIfAborted();
            const ingress = hostIngressProof();
            if (ownerIngressEvidence(ingress)?.authority?.flow) {
              authorizationRefused();
            }
            if (
              typeof input.operationKey !== "string" ||
              !input.operationKey.trim() ||
              input.operationKey !== input.operationKey.trim()
            ) {
              throw new TypeError(
                "Operation key must be non-empty text without surrounding whitespace.",
              );
            }
            const operationId = await deriveWorkflowId(
              "operation",
              base.event.namespace,
              input.operationKey,
            );
            const preparedOperation = await prepareActionOperation(
              {
                store: scopedStore,
                coordinator: scopedCoordinator,
                actions: (execution?.registry ?? options.registry).actions,
                protectedValues: scopedCapabilities.protectedValues,
              },
              base.event.namespace,
              operationId,
              input,
            );
            const committed = await createSchemaCommandRunner(
              scopedStore.session,
              base.databaseSchema,
            )("actions.start", input, async (_input, command) => {
              const { transaction, commandTime } = command;
              if (base.settlementScopeId || base.source?.kind === "delivery") {
                const live = await transaction.query<
                  { operation: boolean; delivery: boolean }
                >(
                  `SELECT ($2::text IS NULL OR EXISTS(SELECT 1 FROM ${
                    createOperationCatalogTables(base.databaseSchema).operations
                  }
                    WHERE namespace=$1 AND operation_id=$2 AND state IN ('accepted','running') AND cancellation_requested_at IS NULL)) AS operation,
                    ($3::text IS NULL OR EXISTS(SELECT 1 FROM ${scopedStore.tables.event_deliveries}
                    WHERE id=$3 AND status='leased' AND lease_owner=$4
                    AND (lease_expires_at IS NULL OR lease_expires_at>$5::timestamptz)
                    AND owner_epoch=$6::bigint)) AS delivery`,
                  [
                    base.event.namespace,
                    base.settlementScopeId ?? null,
                    base.source?.kind === "delivery" ? base.source.id : null,
                    base.executionIncarnationId,
                    commandTime,
                    command.caller.epoch,
                  ],
                );
                if (!live.rows[0].operation) {
                  throw new Error(
                    "Operation admission lost its active source operation.",
                  );
                }
                if (!live.rows[0].delivery) {
                  throw new Error(
                    "Operation admission lost its delivery lease.",
                  );
                }
              }
              return await admitActionOperation(
                {
                  store: scopedStore,
                  coordinator: scopedCoordinator,
                  actions: (execution?.registry ?? options.registry).actions,
                  protectedValues: scopedCapabilities.protectedValues,
                },
                transaction,
                {
                  namespace: base.event.namespace,
                  operationId,
                  start: input,
                  ingress,
                  correlationId: base.event.correlationId,
                  causationId: base.event.durable
                    ? base.event.id
                    : base.event.causationId,
                  metadata: {
                    observationKeys: base.event.metadata.observationKeys ??
                      [],
                  },
                },
                preparedOperation,
              );
            });
            if (committed) await awaitEventPublication(committed);
            return operationId;
          },
        },
        base,
        actionResumption,
        registry: execution?.registry ?? options.registry,
        assets: scopedCapabilities.assets,
        preparer,
        resolver: scopedResolver,
        collections: scopedCapabilities.collections,
        streamBodyStore: scopedCapabilities.streamBodyStore,
        streamBodyPrefix: assetBodySchemaPrefix({
          prefix: engineOptions.assetStorage?.prefix,
          databaseSchema: base.databaseSchema,
        }),
        operationCatalog: scopedOperationCatalog,
        eventHub: scopedEventHub,
        async publishOutput(output) {
          if (isStreamOutputDescriptor(output)) {
            await (execution?.publish ?? options.publish)?.(output, {
              databaseSchema: base.databaseSchema,
              ...(base.settlementScopeId
                ? { settlementScopeId: base.settlementScopeId }
                : {}),
            });
            return;
          }
          const dispatched = await publishLive(output, {
            inline: true,
            signal: base.signal,
            databaseSchema: base.databaseSchema,
            eventHub: scopedEventHub,
            settlementScopeId: base.settlementScopeId,
            actionScopeId: base.actionScopeId,
          });
          await dispatched.done;
        },
        async publishLocalStream(output) {
          if (!options.publishLocalStream) {
            throw new Error(
              "Unscoped content streams require a local output authority.",
            );
          }
          await options.publishLocalStream(output, {
            databaseSchema: base.databaseSchema,
          });
        },
        actionLifecycle: createActionLifecycleEmitter({
          namespace: base.event.namespace,
          append: createActionLifecycleAppender({
            ...(base.source?.kind === "delivery" &&
                base.source.consumerId ===
                  "processor:copilotz.server.action-request"
              ? {
                finishTerminal: async (
                  transaction: import("../events/session.ts").SqlExecutor,
                ) => {
                  // Stream relays drain outside the queue. Only a stream-free
                  // synchronous root can settle at its own terminal commit.
                  const streams = await transaction.query(
                    `SELECT 1 FROM "${base.databaseSchema}"."copilotz_operation_streams" WHERE namespace=$1 AND operation_id=$2 LIMIT 1`,
                    [base.event.namespace, base.settlementScopeId],
                  );
                  if (streams.rows.length) return;
                  await scopedStore.succeedDelivery(
                    base.source!.id,
                    base.executionIncarnationId!,
                    transaction,
                  );
                  await scopedOperationCatalog.reconcile({
                    namespace: base.event.namespace,
                    operationId: base.settlementScopeId,
                  }, transaction);
                },
              }
              : {}),
            coordinator: scopedCoordinator,
            store: scopedStore,
            actions: (execution?.registry ?? options.registry).actions,
            protectedValues: scopedCapabilities.protectedValues,
            protectedActionOutput: (data) =>
              authorizedActions.output({
                actionId: data.actionId,
                actionRunId: data.actionRunId,
                parentActionRunId: data.parentActionRunId,
                signal: base.signal,
              }),
            ...(base.source?.kind === "delivery" && base.executionIncarnationId
              ? {
                writer: {
                  kind: "delivery" as const,
                  deliveryId: base.source.id,
                  leaseOwner: base.executionIncarnationId,
                },
              }
              : {}),
          }),
          load: createActionLifecycleLoader({
            store: scopedStore,
            actions: (execution?.registry ?? options.registry).actions,
            protectedValues: scopedCapabilities.protectedValues,
          }),
          metadata: {
            ...(base.event.durable ? { sourceEventId: base.event.id } : {}),
            ...(base.source?.kind === "delivery"
              ? {
                sourceDeliveryId: base.source.id,
                ...(base.source.consumerId
                  ? { sourceConsumerId: base.source.consumerId }
                  : {}),
              }
              : {}),
            ...(base.source?.kind === "stream"
              ? { sourceStreamId: base.source.id }
              : {}),
            ...(base.source?.kind === "live"
              ? { sourceLiveDispatchId: base.source.id }
              : {}),
          },
        }),
        protectedEventResolver: async () => {
          const eventId = base.event.durable ? base.event.id : undefined;
          if (!eventId) throw new Error("Action source Event is not durable.");
          const event = await scopedStore.getEvent(eventId);
          if (!event || event.namespace !== base.event.namespace) {
            throw new Error("Protected Event is unavailable in this scope.");
          }
          const raw = await readEventBody(
            { transaction: scopedStore.session, tables: scopedStore.tables },
            event.namespace,
            eventDataRef(event.payload),
          );
          return await openProtectedEventBody({
            namespace: event.namespace,
            body: raw,
            protectedValues: scopedCapabilities.protectedValues,
          });
        },
        now,
      });
    };
    const createContext = async (
      base: DeliveryContextBase,
      actionResumption?:
        import("../actions/invoker.ts").CreateActionCallersOptions[
          "resumption"
        ],
      execution?: OwnerExecutionOptions,
    ): Promise<ProcessorContext> =>
      await createContextFor(
        {
          databaseSchema: base.databaseSchema,
          event: base.event,
          signal: base.signal,
          executionIncarnationId: base.dispatchAttemptId,
          settlementScopeId: base.settlementScopeId,
          actionScopeId: base.actionScopeId,
          idempotencyKey: base.idempotencyKey,
          createMutationIdentity: base.createMutationIdentity,
          source: {
            kind: "delivery",
            id: base.delivery.id,
            consumerId: base.delivery.consumerId,
          },
        },
        actionResumption,
        execution,
      );
    const resolveAuthority = async (schema: string) =>
      await (schema === databaseSchema
        ? store
        : (await resolveAdditionalScope(schema)).runtime.store)
        .executionAuthority();

    const createLiveContext = async (
      base: LiveProcessorContextBase,
      execution?: OwnerExecutionOptions,
    ): Promise<ProcessorContext> =>
      await createContextFor(
        {
          databaseSchema: base.databaseSchema,
          event: base.event,
          signal: base.signal,
          executionIncarnationId: base.dispatchAttemptId,
          ...(base.settlementScopeId
            ? { settlementScopeId: base.settlementScopeId }
            : {}),
          actionScopeId: base.actionScopeId,
          idempotencyKey: base.idempotencyKey,
          createMutationIdentity: base.createMutationIdentity,
          source: {
            kind: "live",
            id: base.dispatchAttemptId,
            consumerId: `processor:${base.processorId}`,
          },
        },
        undefined,
        execution,
      );

    const configuredWorkloads = options.execution?.workloads ?? {};
    const createWorkerWorkloads:
      import("../execution/workload.ts").OwnerExecutionFactory = (
        execution,
      ) => {
        const context: typeof createContext = (base, resumption) =>
          createContext(base, resumption, execution);
        return {
          [options.execution?.workload ?? "copilotz.delivery.v1"]:
            createDeliveryWorkload({
              registry: execution.registry,
              workerId: execution.workerId,
              localExecution: execution.localExecution,
              remoteSession: execution.remoteSession,
              resolvedEvent: execution.resolvedEvent,
              trackAttempt: execution.trackAttempt,
              onDiagnostic: execution.onDiagnostic,
              resolveStore: async (schema) =>
                schema === databaseSchema
                  ? store
                  : (await resolveAdditionalScope(schema)).runtime.store,
              createContext: context,
              async executeContinuation(base) {
                const runtime = base.databaseSchema === databaseSchema
                  ? primaryRuntime!
                  : (await resolveAdditionalScope(base.databaseSchema)).runtime;
                await executeActionContinuation({
                  store: runtime.store,
                  actions: execution.registry.actions,
                  protectedValues: runtime.capabilities.protectedValues,
                  base,
                  createContext: context,
                });
              },
            }),
        };
      };

    const executor: DeliveryExecutor = createDeliveryExecutor({
      createWorkerWorkloads: (execution) => createWorkerWorkloads(execution),
      ...(options.execution ?? {}),
      workloads: configuredWorkloads,
      resolveStore: async (requestedDatabaseSchema) =>
        requestedDatabaseSchema === databaseSchema
          ? store
          : (await resolveAdditionalScope(requestedDatabaseSchema)).runtime
            .store,
      defaultDatabaseSchema: databaseSchema,
      registry: options.registry,
      createContext,
      async executeContinuation(base) {
        const runtime = base.databaseSchema === databaseSchema
          ? primaryRuntime!
          : (await resolveAdditionalScope(base.databaseSchema)).runtime;
        await executeActionContinuation({
          store: runtime.store,
          actions: options.registry.actions,
          protectedValues: runtime.capabilities.protectedValues,
          base,
          createContext,
        });
      },
      async onDeliverySettled(result) {
        const runtime = result.delivery.databaseSchema === databaseSchema
          ? primaryRuntime!
          : (await resolveAdditionalScope(result.delivery.databaseSchema))
            .runtime;
        await runtime.operationCatalog.reconcile({
          namespace: result.event.namespace,
          operationId: result.delivery.settlementScopeId,
        });
        await options.execution?.onDeliverySettled?.(result);
      },
      async onOutput(output, context) {
        if (isStreamOutputDescriptor(output)) {
          await options.publish?.(output, context);
          await options.execution?.onOutput?.(output, context);
          return;
        }
        const event = output;
        const additional = context.databaseSchema === databaseSchema
          ? undefined
          : await resolveAdditionalScope(context.databaseSchema);
        const scoped = additional
          ? { store: additional.runtime.store, hub: additional.hub }
          : { store, hub: eventHub };
        const relayKey = event.durable
          ? `${context.databaseSchema}\u0000${event.id}`
          : undefined;
        const publish = relayKey === undefined ||
          !relayedDurableIds.has(relayKey);
        if (relayKey && publish) {
          relayedDurableIds.add(relayKey);
          relayedDurableOrder.push(relayKey);
          if (relayedDurableOrder.length > 10_000) {
            const removed = relayedDurableOrder.shift();
            if (removed) relayedDurableIds.delete(removed);
          }
        }
        if (publish) {
          const resolvedEvent = await resolveEventInScope(
            event,
            context.databaseSchema,
          );
          const eventData = resolvedEvent.data;
          if (!event.durable) await scoped.hub.publish(event);
          await invokeLiveProcessors({
            databaseSchema: context.databaseSchema,
            registry: options.registry,
            transients: transientsFor(context.databaseSchema),
            event,
            eventData,
            resolvedEvent,
            signal: new AbortController().signal,
            createContext: createLiveContext,
          }).catch(() => undefined);
          await options.publish?.(resolvedEvent, context);
          await options.execution?.onOutput?.(resolvedEvent, context);
        }
        if (!event.durable) return;
        const deliveries = await scoped.store.listDeliveries({
          namespace: event.namespace,
          eventId: event.id,
          status: "pending",
          limit: 1_000,
        });
        for (const delivery of deliveries) {
          executor.scheduleDelivery(delivery);
          reportDeliveryDiagnostic(options.execution?.onDiagnostic, {
            phase: "child_delivery_scheduled",
            timestampMs: Date.now(),
            eventId: event.id,
            deliveryId: delivery.id,
            consumerId: delivery.consumerId,
            databaseSchema: context.databaseSchema,
            namespace: event.namespace,
            status: delivery.status,
            origin: "scheduled",
          });
        }
      },
    });
    const publishLive = async (
      event: CopilotzEvent,
      publishOptions: {
        inline?: boolean;
        signal?: AbortSignal;
        databaseSchema?: string;
        eventHub?: typeof eventHub;
        settlementScopeId?: string;
        actionScopeId?: string;
      } = {},
    ): Promise<LiveEventDispatchHandle> => {
      const scopedDatabaseSchema = publishOptions.databaseSchema ??
        databaseSchema;
      const scopedEventHub = publishOptions.eventHub ?? eventHub;
      const resolvedEvent = await resolveEventInScope(
        event,
        scopedDatabaseSchema,
      );
      const eventData = resolvedEvent.data;
      if (!event.durable) await scopedEventHub.publish(event);
      await options.publish?.(resolvedEvent, {
        databaseSchema: scopedDatabaseSchema,
        ...(publishOptions.settlementScopeId
          ? { settlementScopeId: publishOptions.settlementScopeId }
          : {}),
      });
      // Transient processors are connection-local. Never place them on a Worker.
      const abort = new AbortController();
      const relay = () => abort.abort(publishOptions.signal?.reason);
      if (publishOptions.signal?.aborted) relay();
      else {
        publishOptions.signal?.addEventListener("abort", relay, {
          once: true,
        });
      }
      const scopedTransients = transientsFor(scopedDatabaseSchema);
      const done = invokeLiveProcessors({
        databaseSchema: scopedDatabaseSchema,
        registry: options.registry,
        transients: scopedTransients,
        event,
        eventData,
        resolvedEvent,
        signal: abort.signal,
        settlementScopeId: publishOptions.settlementScopeId,
        actionScopeId: publishOptions.actionScopeId,
        createContext: createLiveContext,
      }).finally(() => {
        publishOptions.signal?.removeEventListener("abort", relay);
      });
      done.catch(() => undefined);
      return ({
        event,
        processorIds: scopedTransients.match(event, eventData).map((
          processor,
        ) => processor.id),
        done,
        async cancel(reason = "live_event_cancelled") {
          abort.abort(new Error(reason));
          await done.catch(() => undefined);
        },
      } as const);
    };
    try {
      const scope = createDatabaseScope({
        owner,
        databaseSchema,
        store,
        engine: engineOptions,
        registry: options.registry,
        executor,
        preparer,
        eventHub,
        now,
        transients,
        operationCatalog,
        publishLive: (event, settlementScopeId, actionScopeId) =>
          publishLive(event, { settlementScopeId, actionScopeId }),
      });
      primaryRuntime = scope;
      capabilities = scope.capabilities;
      resolver = scope.public.content.resolver;

      resolveAdditionalScope = (requested: string) => {
        const normalized = requested.trim();
        if (!normalized) {
          throw new TypeError("Database schema must be non-empty.");
        }
        const existing = additionalScopes.get(normalized);
        if (existing) return existing;
        if (closed) throw new Error("Copilotz engine is shut down.");
        const hub = createCopilotzEventHub();
        const pending = (async () => {
          let scopedOwner: DatabaseOwner | undefined;
          try {
            // Selecting a tenant scope is a request-path operation. It must never
            // acquire DDL locks or implicitly create tenant infrastructure.
            await validateCopilotzSchema(options.session, normalized);
            await validateOperationCatalog(options.session, normalized);
            await validateCollectionIndexes(
              options.session,
              normalized,
              definitions,
            );
            scopedOwner = await openDatabaseOwner(
              options.session,
              normalized,
              { now: options.now, alarmScheduler: options.alarmScheduler },
            );
            construction.ownerAcquired?.(normalized, scopedOwner);
            const scopedOperationCatalog = createOperationCatalog(
              options.session,
              normalized,
              {
                onSettled: async (transaction, input) =>
                  runtime.deferPublication(
                    await scheduleResumptions(
                      {
                        store: runtime.store,
                        coordinator: runtime.coordinator,
                      },
                      input,
                      transaction,
                    ),
                  ),
                onStreamTerminal: ({ namespace, operationId }) => {
                  void scopedOperationCatalog.reconcile({
                    namespace,
                    operationId,
                  }).catch(() => undefined);
                },
                beforeTerminal: ({ namespace, operationId }) =>
                  executor.settleOutputs({
                    databaseSchema: normalized,
                    namespace,
                    settlementScopeId: operationId,
                  }),
              },
            );
            const scopedTransients = configuredTransients();
            transientsBySchema.set(normalized, scopedTransients);
            const runtime = createDatabaseScope({
              owner: scopedOwner,
              databaseSchema: normalized,
              engine: engineOptions,
              registry: options.registry,
              executor,
              preparer,
              eventHub: hub,
              now,
              transients: scopedTransients,
              operationCatalog: scopedOperationCatalog,
              publishLive: (event, settlementScopeId, actionScopeId) =>
                publishLive(event, {
                  databaseSchema: normalized,
                  eventHub: hub,
                  settlementScopeId,
                  actionScopeId,
                }),
            });
            await runtime.activate();
            const activated = { runtime, hub } as const;
            // Recovery publications can resolve this schema again. Make the
            // activated capabilities available before dispatching that work.
            additionalScopes.set(normalized, Promise.resolve(activated));
            await runtime.publishActivation();
            return activated;
          } catch (error) {
            additionalScopes.delete(normalized);
            if (scopedOwner) releaseDatabaseOwner(scopedOwner);
            transientsBySchema.delete(normalized);
            hub.close(error);
            throw error;
          }
        })().catch((error) => {
          transientsBySchema.delete(normalized);
          if (additionalScopes.get(normalized) === pending) {
            additionalScopes.delete(normalized);
          }
          throw error;
        });
        additionalScopes.set(normalized, pending);
        return pending;
      };

      const engine: CopilotzEngine = {
        ...scope.public,
        databaseSchema,
        async databaseScope(requestedDatabaseSchema) {
          if (requestedDatabaseSchema.trim() === databaseSchema) return engine;
          return (await resolveAdditionalScope(requestedDatabaseSchema)).runtime
            .public;
        },
        plugins: options.registry,
        execution: {
          ownership: executor.ownership,
          workload: executor.workload,
          workloads: executor.workloads,
          createWorkerWorkloads,
          async lookupReceipt(identity, input) {
            const schema = String(
              (input as { databaseSchema?: unknown })?.databaseSchema ?? "",
            );
            if (
              !schema || !canRecoverCollectionReceipt(
                (input as { intent?: unknown })?.intent,
                options.registry.collections,
                collectionPolicyRegistrations,
              )
            ) return false;
            // A receipt read never provisions or acquires a database scope.
            return await readSchemaReceipt(
              options.session,
              schema,
              `worker:${identity.workerId}`,
              input,
            );
          },
          resolveAuthority,
          dispatchWork: (input) => executor.dispatchWork(input),
          settleOutputs: (scope) => executor.settleOutputs(scope),
          awaitScopeProgress: (scope, signal) =>
            executor.awaitScopeProgress(scope, signal),
        } as const,
        async recoverAll(recovery = {}) {
          const scoped = await Promise.allSettled([
            ...additionalScopes.values(),
          ]);
          const unavailableScopes = scoped.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []
          );
          if (unavailableScopes.length) {
            throw new AggregateError(
              unavailableScopes,
              "Could not resolve every Copilotz database scope for recovery.",
            );
          }
          const results = await Promise.all([
            scope.public.recover(recovery),
            ...scoped.flatMap((result) =>
              result.status === "fulfilled"
                ? [result.value.runtime.public.recover(recovery)]
                : []
            ),
          ]);
          return ({
            handles: results.flatMap((result) => result.handles),
            failures: results.flatMap((result) => result.failures),
          } as const);
        },
        bindTransient(processor: Processor) {
          return Promise.resolve(transients.add(processor));
        },
        shutdown(reason = "copilotz_engine_shutdown") {
          if (shutdownPromise) return shutdownPromise;
          closed = true;
          shutdownPromise = Promise.resolve().then(async () => {
            const errors: unknown[] = [];
            const cleanup = async (run: () => unknown) => {
              try {
                await run();
              } catch (error) {
                errors.push(error);
              }
            };
            const scoped = await Promise.allSettled([
              ...additionalScopes.values(),
            ]);
            const runtimes = [
              scope,
              ...scoped.flatMap((result) =>
                result.status === "fulfilled" ? [result.value.runtime] : []
              ),
            ];
            for (const runtime of runtimes) {
              await cleanup(() => pauseFinalDatabaseOwnerAlarms(runtime.owner));
            }
            // Remove this attachment's sources before the bounded drain. New
            // wakes on a shared owner must use a surviving attachment, while
            // already-admitted callbacks are awaited before executor teardown.
            for (const runtime of runtimes) {
              await cleanup(() => runtime.closeAlarms());
            }
            await Promise.all(
              runtimes.map((runtime) =>
                cleanup(() => runtime.owner.drainAlarms())
              ),
            );
            await cleanup(() => executor.shutdown(reason));
            for (const runtime of runtimes) {
              await cleanup(() => runtime.closePush());
              await cleanup(() => releaseDatabaseOwner(runtime.owner));
            }
            for (const result of scoped) {
              if (result.status === "fulfilled") {
                await cleanup(() => result.value.hub.close());
              }
            }
            if (ownsEventHub) await cleanup(() => eventHub.close());
            if (errors.length) throw errors[0];
          });
          return shutdownPromise;
        },
      };
      await construction.beforeRecovery?.(engine);
      await scope.activate();
      await scope.publishActivation();
      return engine;
    } catch (error) {
      primaryRuntime?.closePush();
      await executor.shutdown("copilotz_engine_initialization_failed").catch(
        () => undefined,
      );
      if (ownsEventHub) eventHub.close(error);
      throw error;
    }
  } catch (error) {
    releaseDatabaseOwner(owner);
    throw error;
  }
}
