import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../events/schema.ts";
import { digestContent } from "./digest.ts";
import { inspectEmbeddedContent } from "./migration.ts";
import { createLegacyObjectBodyStore } from "./legacy-object-body-store.ts";

Deno.test("16 legacy inspection workers under database load recover bounded read faults with sequential plan parity", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = "synthetic_concurrent_inspection";
  const bytes = new TextEncoder().encode("synthetic retained bytes"),
    digest = await digestContent(bytes);
  const config = {
    backendId: "synthetic:concurrent",
    endpoint: "https://objects.example.test",
    bucket: "synthetic",
    region: "auto",
    accessKeyId: "synthetic",
    secretAccessKey: "synthetic",
    requestTimeoutMs: 100,
  };
  try {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await provisionCopilotzSchema(db, schema);
    const tables = createCoreTableNames(schema);
    await db.query(
      `INSERT INTO ${tables.nodes}(namespace,id,type,name,data) SELECT 'synthetic','node-'||i,'asset','synthetic',jsonb_build_object('padding',repeat('x',4096),'location',jsonb_build_object('kind','object','backendId',$1::text,'key','object-'||i),'byteLength',$2::integer,'digest',$3::text) FROM generate_series(0,63) i`,
      [config.backendId, bytes.length, digest],
    );
    let active = 0, peak = 0, faults = 0;
    const inspect = (concurrency: number, inject: boolean, readRetries = 3) => {
      const attempts = new Map<string, number>();
      const store = createLegacyObjectBodyStore(config, {
        readRetries,
        retryDelayMs: 1,
        fetch: async (input) => {
          assert(input instanceof Request);
          active++;
          peak = Math.max(peak, active);
          try {
            const id = Number(new URL(input.url).pathname.split("-").at(-1));
            const key = input.method + input.url,
              attempt = (attempts.get(key) ?? 0) + 1;
            attempts.set(key, attempt);
            await db.query(
              `SELECT sum(length(data::text)) FROM ${tables.nodes}`,
            );
            if (inject && attempt === 1 && id % 13 === 0) {
              faults++;
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                  input.signal.removeEventListener("abort", abort);
                  resolve();
                }, 200);
                const abort = () => {
                  clearTimeout(timer);
                  reject(new Error("synthetic slow response"));
                };
                if (input.signal.aborted) abort();
                else {input.signal.addEventListener("abort", abort, {
                    once: true,
                  });}
              });
            }
            await new Promise((resolve) => setTimeout(resolve, id % 5));
            if (inject && attempt === 1 && id % 11 === 0) {
              faults++;
              throw new TypeError("synthetic transport reset");
            }
            if (inject && attempt === 1 && (id % 7 === 0 || id % 5 === 0)) {
              faults++;
              return new Response(null, { status: id % 7 === 0 ? 429 : 503 });
            }
            const headers = new Headers({
              etag: '"pinned"',
              "content-length": String(bytes.length),
              "content-type": "text/plain",
              "x-amz-meta-copilotz-sha256": digest.slice(7),
            });
            if (input.method === "HEAD") return new Response(null, { headers });
            assertEquals(input.headers.get("if-match"), '"pinned"');
            headers.set(
              "content-range",
              `bytes 0-${bytes.length - 1}/${bytes.length}`,
            );
            return new Response(bytes, { status: 206, headers });
          } finally {
            active--;
          }
        },
      });
      return inspectEmbeddedContent({
        session: db,
        schema,
        concurrency,
        storeFor: () => store,
      });
    };
    const sequential = await inspect(1, false);
    await assertRejects(() => inspect(16, true, 0));
    assertEquals(active, 0);
    assertEquals(await inspect(16, true), sequential);
    assert(peak > 1 && peak <= 16);
    assert(faults > 0);
    assertEquals(active, 0);
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});
