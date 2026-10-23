/**
 * deno run -A scripts/benchmark-id-storage.ts [rows=1000000] [10000000]
 * Uses COPILOTZ_TEST_POSTGRES_URL. Creates and drops only its unique schema.
 * Ordered, equivalent 128-bit identities isolate representation from UUIDv4
 * randomness. Key generation/staging is outside the measured inserts.
 */
import { openManagedOminipgDatabase } from "../runtime/persistence/index.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
if (!url || !/^postgres(?:ql)?:/.test(url)) {
  throw new Error(
    "Set COPILOTZ_TEST_POSTGRES_URL to the benchmark Postgres database.",
  );
}
const sizes = Deno.args.length ? Deno.args.map(Number) : [1_000_000];
if (sizes.some((n) => !Number.isSafeInteger(n) || n < 1000 || n > 10_000_000)) {
  throw new Error("Row counts must be integers from 1000 through 10000000.");
}
const database = await openManagedOminipgDatabase({
  url,
  requestTimeoutMs: 300_000,
  pgPoolMax: 1,
});
const db = database.session;
const schema = `benchmark_ids_${crypto.randomUUID().replaceAll("-", "")}`;
const table = (name: string) => `"${schema}"."${name}"`;
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ids(n: number) {
  let value = BigInt(n), suffix = "";
  for (let i = 0; i < 16; i++) {
    suffix = alphabet[Number(value & 31n)] + suffix;
    value >>= 5n;
  }
  return {
    text: `0000000001${suffix}`,
    uuid: `00000000-0001-0000-0000-${n.toString(16).padStart(12, "0")}`,
  };
}
async function timed(run: () => Promise<unknown>) {
  const start = performance.now();
  await run();
  return performance.now() - start;
}
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    meanMs: values.reduce((a, b) => a + b, 0) / values.length,
    p50Ms: sorted[Math.floor(sorted.length * .5)],
    p95Ms: sorted[Math.floor(sorted.length * .95)],
  };
}
try {
  await db.query(`CREATE SCHEMA "${schema}"`);
  const environment = (await db.query(
    `SELECT version(),current_setting('shared_buffers') AS shared_buffers,current_setting('synchronous_commit') AS synchronous_commit,(SELECT datcollate FROM pg_database WHERE datname=current_database()) AS lc_collate`,
  )).rows[0];
  console.log(JSON.stringify({
    environment,
    methodology:
      "Single connection; ordered equivalent keys; logged tables; 64-byte payload; bulk INSERT SELECT; 100 warmups; 1000 seeded uniform point probes; 100 ordered 1000-row scans; timings include client round trip; no concurrency.",
  }));
  // 80-bit base32 suffix from an integer; fixed 48-bit timestamp = 1.
  await db.query(
    `CREATE FUNCTION "${schema}".ulid_key(n bigint) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
    DECLARE result text := ''; alphabet text := '${alphabet}';
    BEGIN
      FOR i IN 1..16 LOOP result := substr(alphabet, (n & 31)::int+1, 1) || result; n := n >> 5; END LOOP;
      RETURN '0000000001' || result;
    END $$`,
  );
  for (const rows of sizes) {
    await db.query(
      `CREATE UNLOGGED TABLE ${
        table("source")
      } AS SELECT n, "${schema}".ulid_key(n) AS text_id, ('00000000-0001-0000-0000-'||lpad(to_hex(n),12,'0'))::uuid AS uuid_id, repeat('x',64) AS payload FROM generate_series(1,$1::bigint) n`,
      [rows],
    );
    const results = [];
    for (
      const kind
        of (rows > 1_000_000 ? ["uuid", "text"] : ["text", "uuid"]) as (
          | "text"
          | "uuid"
        )[]
    ) {
      await db.query(
        `CREATE TABLE ${table(kind)}(id ${
          kind === "text" ? 'TEXT COLLATE "C"' : "UUID"
        } PRIMARY KEY, payload TEXT NOT NULL)`,
      );
      const insertMs = await timed(() =>
        db.query(
          `INSERT INTO ${table(kind)} SELECT ${kind}_id,payload FROM ${
            table("source")
          } ORDER BY n`,
        )
      );
      await db.query(`ANALYZE ${table(kind)}`);
      const probe = (n: number) =>
        db.query(`SELECT payload FROM ${table(kind)} WHERE id=$1::${kind}`, [
          ids(n)[kind],
        ]);
      for (let i = 0; i < 100; i++) await probe(1 + (i * 7919) % rows);
      let random = 0x12345678;
      const next = () => {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        return 1 + random % (rows - 1000);
      };
      const points: number[] = [], ranges: number[] = [];
      for (let i = 0; i < 1000; i++) {
        points.push(await timed(() => probe(next())));
      }
      for (let i = 0; i < 100; i++) {
        ranges.push(
          await timed(() =>
            db.query(
              `SELECT id,payload FROM ${
                table(kind)
              } WHERE id >= $1::${kind} ORDER BY id LIMIT 1000`,
              [ids(next())[kind]],
            )
          ),
        );
      }
      const size = (await db.query<{ bytes: string }>(
        `SELECT pg_indexes_size($1::regclass)::text AS bytes`,
        [table(kind)],
      )).rows[0];
      results.push({
        kind,
        rows,
        insertMs,
        rowsPerSecond: rows * 1000 / insertMs,
        point: stats(points),
        range1000: stats(ranges),
        indexBytes: Number(size.bytes),
      });
      await db.query(`DROP TABLE ${table(kind)}`);
    }
    console.log(JSON.stringify({ rows, results }));
    await db.query(`DROP TABLE ${table("source")}`);
  }
} finally {
  await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await database.close();
}
