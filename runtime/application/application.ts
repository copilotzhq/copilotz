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

async function closeOwnedSession(
  close: CreateCopilotzApplicationOptions["closeSession"],
  reason: string,
): Promise<void> {
  await close?.(reason);
}

/**
 * Composes the normal embedded Copilotz runtime from plugins and a SQL session.
 * Filesystem/package resolution and database construction remain adapters.
 */
export async function createCopilotzApplication(
  options: CreateCopilotzApplicationOptions,
): Promise<InternalCopilotzApplication> {
  const namespace = optionalText(options.namespace, "Namespace");
  const schema = optionalText(options.schema, "Schema") ?? "public";
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
      session: options.session,
      registry,
      schema,
    });
  } catch (error) {
    await closeOwnedSession(
      options.closeSession,
      "copilotz_application_initialization_failed",
    ).catch(() => undefined);
    throw error;
  }

  let shutdownTask: Promise<void> | undefined;
  const goals = createGoalRuntime({
    registry,
    conversation: engine.conversation,
    resolver: engine.content.resolver,
    run: engine.run,
    defaultNamespace: namespace,
    defaultSchema: schema,
    createId: options.engine?.createId,
    now: options.engine?.now,
  });
  const shutdown = (reason = "copilotz_application_shutdown") => {
    if (shutdownTask) return shutdownTask;
    shutdownTask = (async () => {
      await goals.shutdown(reason);
      const settled = await Promise.allSettled([
        engine.shutdown(reason),
        closeOwnedSession(options.closeSession, reason),
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
      schema,
      corePluginIds: Object.freeze(
        core.map((plugin) => plugin.manifest.id),
      ),
      declaredPluginIds: Object.freeze(declaredPluginIds),
      sessionOwnership: options.closeSession ? "application" : "injected",
    }),
    capabilities: createAgentCapabilityResolver({ registry, toolCatalog }),
    engine,
    connect(input: ApplicationConnectInput) {
      return engine.connect({
        ...input,
        namespace: requiredNamespace(input.namespace, namespace),
        schema: input.schema ?? schema,
      });
    },
    run(input: ApplicationRunInput) {
      return engine.run({
        ...input,
        namespace: requiredNamespace(input.namespace, namespace),
        schema: input.schema ?? schema,
      });
    },
    goal: goals.goal,
    shutdown,
  };
  return Object.freeze(application);
}
