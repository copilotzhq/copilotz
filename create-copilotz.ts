import { corePlugin } from "./plugins/core/plugin.ts";
import { createCopilotz as createEmbeddedCopilotz } from "./runtime/application/copilotz.ts";
import { createCopilotzGateway as createGateway } from "./runtime/application/gateway.ts";
import { createCopilotzWorker as createWorker } from "./runtime/application/worker.ts";
import type { CopilotzPlugin } from "./runtime/plugins/index.ts";

function withCanonicalCore<
  T extends { canonicalCore?: readonly CopilotzPlugin[] },
>(options: T): T {
  return {
    ...options,
    canonicalCore: options.canonicalCore ?? [corePlugin],
  };
}

/** Package-root factory. Injects static `corePlugin` without runtime importing plugins. */
export function createCopilotz(
  options: Parameters<typeof createEmbeddedCopilotz>[0] = {},
  lifecycle?: Parameters<typeof createEmbeddedCopilotz>[1],
): ReturnType<typeof createEmbeddedCopilotz> {
  return createEmbeddedCopilotz(withCanonicalCore(options), lifecycle);
}

export function createCopilotzGateway(
  options: Parameters<typeof createGateway>[0] = {},
  lifecycle?: Parameters<typeof createGateway>[1],
): ReturnType<typeof createGateway> {
  return createGateway(withCanonicalCore(options), lifecycle);
}

export function createCopilotzWorker(
  options: Parameters<typeof createWorker>[0],
  lifecycle?: Parameters<typeof createWorker>[1],
): ReturnType<typeof createWorker> {
  return createWorker(withCanonicalCore(options), lifecycle);
}
