/** Fake read-only store benchmark: no external network or persistent fixture. */
import { inspectEmbeddedContent } from "../runtime/content/migration.ts";
import { createMemoryBodyStore } from "../runtime/content/body-store.ts";
import { digestContent } from "../runtime/content/digest.ts";
import type { SqlSession } from "../runtime/events/session.ts";
const count = Number(Deno.args[0] ?? 20000);
const concurrency = Number(Deno.args[1] ?? 16);
const latencyMs = Number(Deno.args[2] ?? 30);
const bytes = new TextEncoder().encode("synthetic bytes"),
  digest = await digestContent(bytes);
const nodes = Array.from({ length: count }, (_, i) => ({
  namespace: "synthetic",
  id: `object-${i}`,
  data: {
    location: {
      kind: "object",
      backendId: "synthetic:latency",
      key: `object-${i}`,
    },
    byteLength: bytes.length,
    digest,
  },
}));
const session: SqlSession = {
  query: (sql) =>
    Promise.resolve(
      {
        rows: sql.includes('FROM "cutover"."nodes"')
          ? nodes
          : sql.includes("to_regclass")
          ? [{ present: false }]
          : [],
      } as never,
    ),
  transaction: (run) => run(session),
};
let active = 0, peak = 0, requests = 0;
const delay = async () => {
  requests++;
  active++;
  peak = Math.max(peak, active);
  if (latencyMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
  }
  active--;
};
const forbidden = () => {
  throw new Error("read-only benchmark");
};
const store = {
  ...createMemoryBodyStore(),
  kind: "object" as const,
  backendId: "synthetic:latency",
  async head({ bodyId }: { bodyId: string }) {
    await delay();
    return {
      bodyId,
      state: "ready" as const,
      byteLength: bytes.length,
      digest,
      mediaType: "text/plain",
      maintenanceVersion: 1,
      versionToken: "synthetic-version",
    };
  },
  async readRange({ offset, end }: { offset: number; end: number }) {
    await delay();
    return bytes.slice(offset, end);
  },
  put: forbidden,
  reserve: forbidden,
  fence: forbidden,
  append: forbidden,
  seal: forbidden,
  terminate: forbidden,
  abort: forbidden,
  maintenance: { list: forbidden, delete: forbidden },
};
const start = performance.now();
const plan = await inspectEmbeddedContent({
  session,
  schema: "cutover",
  storeFor: () => store,
  concurrency,
});
console.log(
  JSON.stringify({
    objects: plan.inventory.length,
    concurrency,
    latencyMs,
    requests,
    peak,
    elapsedMs: Math.round(performance.now() - start),
    fingerprint: plan.fingerprint,
  }),
);
