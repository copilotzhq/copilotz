import type { CopilotzEvent } from "../events/index.ts";
import type { ProcessorContext } from "../plugins/index.ts";

export type TestProcessorContextSeed = Readonly<{
  databaseSchema?: string;
  event: CopilotzEvent;
  idempotencyKey: string;
  settlementScopeId?: string;
  signal: AbortSignal;
}>;

function unavailable(): never {
  throw new Error("This test Processor context capability is not configured.");
}

/** Complete runtime-neutral context for tests of lower-level execution mechanics. */
export function createTestProcessorContext(
  seed: TestProcessorContextSeed,
): ProcessorContext {
  const content: ProcessorContext["content"] = Object.freeze({
    prepare: unavailable,
    materialize: unavailable,
    publish: unavailable,
    get: unavailable,
    getMany: unavailable,
    resolve: unavailable,
    resolveMany: unavailable,
    open: unavailable,
  });
  return Object.freeze({
    namespace: seed.event.namespace,
    databaseSchema: seed.databaseSchema ?? "public",
    operationKey: seed.idempotencyKey,
    identity: Object.freeze({
      ...(seed.event.durable
        ? { causationId: seed.event.id }
        : seed.event.causationId
        ? { causationId: seed.event.causationId }
        : {}),
      correlationId: seed.event.correlationId,
      deduplicationId: seed.idempotencyKey,
      ...(seed.settlementScopeId
        ? { settlementScopeId: seed.settlementScopeId }
        : {}),
    }),
    resources: Object.freeze({}),
    adapters: Object.freeze({}),
    actions: Object.freeze({}),
    collections: Object.freeze({}),
    content,
    streams: Object.freeze({
      open: unavailable,
      follow: unavailable,
    }),
    signal: seed.signal,
    now: () => new Date(),
    transaction: unavailable,
  });
}
