import { createAgentCapabilityResolver } from "../capabilities/index.ts";
import { createCopilotzEngine } from "../engine/index.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import { createGoalRuntime } from "../goals/index.ts";
import { createWorkflowToolCatalog } from "../workflows/index.ts";
import { createCopilotzCorePlugins } from "./core-plugins.ts";
import type {
  ApplicationConnectInput,
  ApplicationRunInput,
  CreateCopilotzApplicationOptions,
  InternalCopilotzApplication,
} from "./types.ts";
import {
  type CopilotzPersistenceLifecycleCallbacks,
  type OpenCopilotzPersistence,
  openCopilotzPersistence,
} from "./persistence.ts";

export function observeApplicationPersistence(
  persistence: OpenCopilotzPersistence,
  application: Pick<
    InternalCopilotzApplication,
    "disconnectAttachments" | "recoverAll"
  >,
  options: Readonly<{ recoverDurable?: boolean }> = {},
): () => void {
  return persistence.recovery?.register({
    onUnavailable: (error) => application.disconnectAttachments(error),
    async onReady() {
      if (options.recoverDurable === false) return;
      await application.recoverAll({ limit: 1_000 });
    },
  }) ?? (() => undefined);
}

function optionalText(value: string | undefined, name: string) {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function requiredNamespace(
  explicit: string | undefined,
  fallback: string | undefined,
): string {
  const namespace = explicit?.trim() || fallback;
  if (!namespace) {
    throw new TypeError(
      "A tenant namespace is required on the application or operation.",
    );
  }
  return namespace;
}

/**
 * Composes the normal embedded Copilotz runtime from plugins and a database.
 * Filesystem/package resolution and database construction remain adapters.
 */
export async function createCopilotzApplication(
  options: CreateCopilotzApplicationOptions,
  lifecycle: CopilotzPersistenceLifecycleCallbacks =
    options.databaseLifecycle ?? {},
): Promise<InternalCopilotzApplication> {
  const persistence = await openCopilotzPersistence(options, lifecycle);
  const namespace = optionalText(options.namespace, "Namespace");
  const databaseSchema = optionalText(
    options.databaseSchema,
    "Database schema",
  ) ?? "public";
  const configuredTextCatalog = options.core !== false &&
      options.core?.text !== false
    ? options.core?.text?.toolCatalog
    : undefined;
  if (
    options.toolCatalog && configuredTextCatalog &&
    options.toolCatalog !== configuredTextCatalog
  ) {
    throw new TypeError(
      "Application toolCatalog must match core.text.toolCatalog when both are provided.",
    );
  }
  const toolCatalog = options.toolCatalog ?? configuredTextCatalog ??
    createWorkflowToolCatalog();
  const core = createCopilotzCorePlugins(options.core, { toolCatalog });
  const registry = await createPluginRegistry({
    core,
    plugins: options.plugins,
    resources: options.resources,
    resolver: options.pluginResolver,
  });

  let engine;
  try {
    engine = await createCopilotzEngine({
      ...(options.engine ?? {}),
      session: persistence.session,
      registry,
      defaultDatabaseSchema: databaseSchema,
      assets: options.assets,
    });
  } catch (error) {
    await persistence.close("copilotz_application_initialization_failed").catch(
      () => undefined,
    );
    throw error;
  }

  let shutdownTask: Promise<void> | undefined;
  let stopObservingPersistence: () => void = () => undefined;
  const goalScopes = new Map<
    string,
    Promise<ReturnType<typeof createGoalRuntime>>
  >();
  const goalsFor = (requestedDatabaseSchema: string) => {
    const requested = optionalText(
      requestedDatabaseSchema,
      "Goal database schema",
    )!;
    const existing = goalScopes.get(requested);
    if (existing) return existing;
    const pending = engine.databaseScope(requested).then((scope) =>
      createGoalRuntime({
        registry,
        conversation: scope.conversation,
        resolver: scope.content.resolver,
        run: (input) =>
          scope.run({
            ...input,
            databaseSchema: requested,
          }),
        defaultNamespace: namespace,
        defaultDatabaseSchema: requested,
        createId: options.engine?.createId,
        now: options.engine?.now,
      })
    ).catch((error) => {
      if (goalScopes.get(requested) === pending) goalScopes.delete(requested);
      throw error;
    });
    goalScopes.set(requested, pending);
    return pending;
  };
  await goalsFor(databaseSchema);
  const shutdown = (reason = "copilotz_application_shutdown") => {
    if (shutdownTask) return shutdownTask;
    stopObservingPersistence();
    shutdownTask = (async () => {
      const goalRuntimes = await Promise.allSettled([...goalScopes.values()]);
      await Promise.all(
        goalRuntimes.flatMap((result) =>
          result.status === "fulfilled"
            ? [result.value.shutdown(reason).catch(() => undefined)]
            : []
        ),
      );
      const settled = await Promise.allSettled([
        engine.shutdown(reason),
        persistence.close(reason),
      ]);
      const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Copilotz application shutdown failed.",
        );
      }
    })();
    shutdownTask.catch(() => undefined);
    return shutdownTask;
  };

  const declaredPluginIds = registry.plugins
    .slice(core.length)
    .map((plugin) => plugin.manifest.id);
  const application: InternalCopilotzApplication = {
    ...engine,
    config: Object.freeze({
      ...(namespace ? { namespace } : {}),
      databaseSchema,
      corePluginIds: Object.freeze(
        core.map((plugin) => plugin.manifest.id),
      ),
      declaredPluginIds: Object.freeze(declaredPluginIds),
      databaseOwnership: persistence.ownership,
    }),
    capabilities: createAgentCapabilityResolver({ registry, toolCatalog }),
    engine,
    async databaseScope(requestedDatabaseSchema) {
      await persistence.recovery?.admit();
      return await engine.databaseScope(requestedDatabaseSchema);
    },
    async connect(input: ApplicationConnectInput) {
      await persistence.recovery?.admit();
      return engine.connect({
        ...input,
        namespace: requiredNamespace(input.namespace, namespace),
        databaseSchema: input.databaseSchema ?? databaseSchema,
      });
    },
    async run(input: ApplicationRunInput) {
      await persistence.recovery?.admit();
      return engine.run({
        ...input,
        namespace: requiredNamespace(input.namespace, namespace),
        databaseSchema: input.databaseSchema ?? databaseSchema,
      });
    },
    async goal(input) {
      await persistence.recovery?.admit();
      const requested = input.databaseSchema?.trim() || databaseSchema;
      return await (await goalsFor(requested)).goal({
        ...input,
        databaseSchema: requested,
      });
    },
    shutdown,
  };
  stopObservingPersistence = observeApplicationPersistence(
    persistence,
    application,
  );
  return Object.freeze(application);
}
