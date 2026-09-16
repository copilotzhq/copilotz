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
  const content: ProcessorContext["content"] = {
    prepare: unavailable,
    materialize: unavailable,
    publish: unavailable,
    get: unavailable,
    getMany: unavailable,
    resolve: unavailable,
    resolveMany: unavailable,
    open: unavailable,
  } as const;
  return ({
    namespace: seed.event.namespace,
    databaseSchema: seed.databaseSchema ?? "public",
    operationKey: seed.idempotencyKey,
    identity: {
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
    } as const,
    resources: {} as const,
    adapters: {} as const,
    actions: {} as const,
    collections: {} as const,
    vectors: { search: unavailable },
    content,
    streams: {
      open: unavailable,
      follow: unavailable,
    } as const,
    signal: seed.signal,
    now: () => new Date(),
    transaction: unavailable,
    readSnapshot: unavailable,
  } as const);
}
