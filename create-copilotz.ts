import { corePlugin } from "./plugins/core/plugin.ts";
import {
  createKnowledgePlugin,
  type CreateKnowledgePluginOptions,
} from "./runtime/knowledge/index.ts";
import {
  createUsageWorkflowPlugin,
  type CreateUsageWorkflowPluginOptions,
} from "./plugins/usage/index.ts";
import { createCopilotz as createEmbeddedCopilotz } from "./runtime/application/copilotz.ts";
import { createCopilotzGateway as createGateway } from "./runtime/application/gateway.ts";
import { createCopilotzWorker as createWorker } from "./runtime/application/worker.ts";
import type { CopilotzPlugin } from "./runtime/plugins/index.ts";

type CorePluginSetting<T> = false | Readonly<T>;

type RuntimeEmbeddedOptions = NonNullable<
  Parameters<typeof createEmbeddedCopilotz>[0]
>;
type RuntimeGatewayOptions = NonNullable<Parameters<typeof createGateway>[0]>;
type RuntimeWorkerOptions = Parameters<typeof createWorker>[0];
type RuntimeCoreOptions = Exclude<
  NonNullable<RuntimeEmbeddedOptions["core"]>,
  false
>;
type RootCoreOptions =
  & RuntimeCoreOptions
  & Readonly<{
    /** Opt-in because an embedding provider resource is required. */
    knowledge?: CorePluginSetting<CreateKnowledgePluginOptions>;
    usage?: CorePluginSetting<CreateUsageWorkflowPluginOptions>;
  }>;

export type RootCompositionOptions<T> =
  & Omit<T, "core" | "plugins">
  & Readonly<{
    core?: false | RootCoreOptions;
    plugins?: readonly CopilotzPlugin[];
  }>;

export type CreateCopilotzOptions = RootCompositionOptions<
  RuntimeEmbeddedOptions
>;
export type CreateCopilotzGatewayOptions = RootCompositionOptions<
  RuntimeGatewayOptions
>;
export type CreateCopilotzWorkerOptions = RootCompositionOptions<
  RuntimeWorkerOptions
>;

function enabled<T>(
  value: false | Readonly<T> | undefined,
  enabledByDefault: boolean,
): Readonly<T> | undefined {
  if (value === false) return undefined;
  if (value !== undefined) return value;
  return enabledByDefault ? ({} as Readonly<T>) : undefined;
}

function withCanonicalCore<T extends RuntimeEmbeddedOptions>(
  options: RootCompositionOptions<T>,
): T {
  const core = options.core;
  const knowledge = core === false || core?.knowledge === undefined ||
      core.knowledge === false
    ? undefined
    : core.knowledge;
  const usage = core === false ? undefined : enabled(core?.usage, false);
  const runtimeCore = core === false ? false : core
    ? Object.fromEntries(
      Object.entries(core).filter(([
        key,
      ]) => key !== "knowledge" && key !== "usage"),
    ) as RuntimeCoreOptions
    : undefined;
  const composedPlugins = [
    ...(knowledge ? [createKnowledgePlugin(knowledge)] : []),
    ...(usage ? [createUsageWorkflowPlugin(usage)] : []),
    ...(options.plugins ?? []),
  ];
  const plugins = composedPlugins.length
    ? Object.freeze([
      ...composedPlugins,
    ])
    : undefined;
  return {
    ...options,
    core: runtimeCore,
    canonicalCore: options.canonicalCore ?? [corePlugin],
    ...(plugins ? { plugins } : {}),
  } as T;
}

/** Package-root factory. Injects static `corePlugin` without runtime importing plugins. */
export function createCopilotz(
  options: CreateCopilotzOptions = {},
  lifecycle?: Parameters<typeof createEmbeddedCopilotz>[1],
): ReturnType<typeof createEmbeddedCopilotz> {
  return createEmbeddedCopilotz(withCanonicalCore(options), lifecycle);
}

export function createCopilotzGateway(
  options: CreateCopilotzGatewayOptions = {},
  lifecycle?: Parameters<typeof createGateway>[1],
): ReturnType<typeof createGateway> {
  return createGateway(withCanonicalCore(options), lifecycle);
}

export function createCopilotzWorker(
  options: CreateCopilotzWorkerOptions,
  lifecycle?: Parameters<typeof createWorker>[1],
): ReturnType<typeof createWorker> {
  return createWorker(withCanonicalCore(options), lifecycle);
}
