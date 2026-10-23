import { assert, assertEquals } from "@std/assert";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { restoreRetainedFixture } from "./fixtures/retained-upgrade/load.ts";
import {
  createS3Fixture,
  s3TestConfig,
} from "../runtime/testing/s3-body-store.fixture.ts";
import { testAuthorityManifest } from "../runtime/testing/upgrade.ts";
import { encodeEventBody } from "../runtime/events/body-store.ts";
import { digestContent } from "../runtime/content/digest.ts";
import { base64ToBytes } from "../runtime/content/encoding.ts";
import { readTransferBodies } from "../runtime/actions/owner-transfer-storage.ts";
import type { RetainedDataUpgradePlan } from "../runtime/actions/upgrade.ts";

Deno.test("legacy v7 CLI cutover reads assets and streams in place, installs v12 database copies, and reaches v14", async () => {
  const directory = await Deno.makeTempDir({ prefix: "cutover-legacy-" });
  const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ||
    `file://${directory}/db`;
  const schema = `legacy_cli_${crypto.randomUUID().replaceAll("-", "")}`;
  const backendId = "gcs:test-bucket";
  const f = createS3Fixture(true);
  let active = 0, peak = 0;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        assert(
          ["HEAD", "GET"].includes(request.method),
          "legacy source must remain read-only",
        );
        return await f.fetch(request);
      } finally {
        active--;
      }
    },
  );
  const storagePath = `${directory}/storage.ts`,
    planPath = `${directory}/plan.json`;
  const keysPath = `${directory}/keys.ts`,
    authorityPath = `${directory}/authority.json`;
  const moduleUrl = (path: string) =>
    JSON.stringify(new URL(path, import.meta.url).href);
  const config = {
    ...s3TestConfig,
    backendId,
    provider: "gcs",
    endpoint: `http://127.0.0.1:${server.addr.port}`,
    prefix: "ignored",
  };
  const expected = new Map<string, Uint8Array>();
  const withDb = async <T>(
    run: (db: Awaited<ReturnType<typeof createTestDatabase>>) => Promise<T>,
  ) => {
    const db = await createTestDatabase({ url });
    try {
      return await run(db);
    } finally {
      await db.close();
    }
  };
  const command = async (args: string[], failure?: string) => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "scripts/upgrade-retained-data.ts",
        ...args,
        `--schema=${schema}`,
      ],
      env: { COPILOTZ_MIGRATION_DATABASE_URL: url },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(result.stderr);
    if (failure) {
      assert(result.code !== 0, stderr);
      assert(stderr.includes(failure), stderr);
      return;
    }
    assertEquals(result.code, 0, stderr);
    return JSON.parse(new TextDecoder().decode(result.stdout));
  };
  const marker = () =>
    withDb(async (db) =>
      (await db.query<{ version: number }>(
        `SELECT version FROM "${schema}".copilotz_schema_metadata`,
      )).rows[0].version
    );
  try {
    await withDb(async (db) => {
      await restoreRetainedFixture(db, schema);
      const bodies =
        (await db.query<{ body_id: string; media_type: string; bytes: string }>(
          `SELECT b.body_id,b.media_type,encode(p.bytes,'base64') AS bytes FROM "${schema}".content_bodies b JOIN "${schema}".content_body_parts p USING(body_id) ORDER BY b.body_id,p.start_offset`,
        )).rows;
      const keys = new Map<string, string>();
      for (const [i, body] of bodies.entries()) {
        const key = body.body_id.startsWith("schemas/")
          ? `prefix/schemas/${schema}/namespaces/archive/origins/message/synthetic/assets/asset-${i}`
          : `prefix/schemas/${schema}/content-streams/archive/incarnation%3A${body.body_id}`;
        const bytes = base64ToBytes(body.bytes);
        keys.set(body.body_id, key);
        expected.set(key, bytes);
        f.objects.set(key, {
          bytes,
          generation: 100 + i,
          etag: `"legacy-${i}"`,
          metadata: {
            "x-goog-meta-copilotz-sha256": (await digestContent(bytes)).slice(
              7,
            ),
            "x-goog-meta-copilotz-media-type": body.media_type,
            "x-goog-meta-copilotz-maintenance-version": "1",
            "x-goog-meta-copilotz-protected-until": "2020-01-01T00:00:00Z",
          },
        });
        await db.query(
          `UPDATE "${schema}".copilotz_operation_streams SET body_id=$2 WHERE body_id=$1`,
          [body.body_id, key],
        );
      }
      function rewrite(value: unknown): unknown {
        if (Array.isArray(value)) return value.map(rewrite);
        if (!value || typeof value !== "object") return value;
        const record = value as Record<string, unknown>;
        if (
          record.kind === "database" && typeof record.key === "string" &&
          keys.has(record.key)
        ) {
          return { kind: "object", backendId, key: keys.get(record.key) };
        }
        return Object.fromEntries(
          Object.entries(record).map((
            [k, v],
          ) => [
            k,
            k === "bodyId" && typeof v === "string" && keys.has(v)
              ? keys.get(v)
              : rewrite(v),
          ]),
        );
      }
      for (
        const row
          of (await db.query<{ namespace: string; id: string; data: unknown }>(
            `SELECT namespace,id,data FROM "${schema}".nodes`,
          )).rows
      ) {
        await db.query(
          `UPDATE "${schema}".nodes SET data=$3::jsonb WHERE namespace=$1 AND id=$2`,
          [row.namespace, row.id, JSON.stringify(rewrite(row.data))],
        );
      }
      for (
        const row of (await db.query<
          { namespace: string; event_body_id: string; body: unknown }
        >(`SELECT namespace,event_body_id,body FROM "${schema}".event_bodies`))
          .rows
      ) {
        const body = await encodeEventBody(rewrite(row.body));
        await db.query(
          `UPDATE "${schema}".event_bodies SET body=$3::jsonb,digest=$4 WHERE namespace=$1 AND event_body_id=$2`,
          [row.namespace, row.event_body_id, body.body, body.digest],
        );
      }
      // Keep one database location to exercise the resolver's default alongside legacy objects.
      const body = bodies.find((body) => body.body_id.startsWith("schemas/"))!,
        bytes = base64ToBytes(body.bytes);
      expected.set(body.body_id, bytes);
      await db.query(
        `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) VALUES('database-fallback','archive','asset','database-fallback',$1::jsonb)`,
        [JSON.stringify({
          location: {
            kind: "database",
            backendId: "database:default",
            key: body.body_id,
          },
          byteLength: bytes.length,
          digest: await digestContent(bytes),
        })],
      );
    });
    await Deno.writeTextFile(
      storagePath,
      `import { createLegacyObjectBodyStore } from ${
        moduleUrl("../runtime/content/index.ts")
      };
const store = createLegacyObjectBodyStore(${JSON.stringify(config)});
export default {
  storeFor: (location) => location.kind === 'object' && location.backendId === store.backendId ? store : undefined,
  streamBackend: { kind: 'object', backendId: store.backendId }, concurrency: 2,
};\n`,
    );
    await Deno.writeTextFile(
      keysPath,
      `import { testSecretAdapter } from ${
        moduleUrl("../runtime/testing/secret-adapter.ts")
      };
const adapter = await testSecretAdapter();
export default { sourceAdapter: adapter, masterAdapter: adapter };\n`,
    );
    assertEquals(await marker(), 7);
    const assetKey = [...f.objects.keys()].find((key) =>
      key.includes("/assets/")
    )!;
    const asset = f.objects.get(assetKey)!;
    const prepare = [
      "prepare",
      `--storage=${storagePath}`,
      `--plan=${planPath}`,
    ];
    f.objects.delete(assetKey);
    await command(prepare, "Migration requires a retained terminal copy");
    f.objects.set(assetKey, asset);
    asset.bytes[0] ^= 255;
    await command(prepare, "Migration integrity mismatch");
    asset.bytes[0] ^= 255;
    const digest = asset.metadata!["x-goog-meta-copilotz-sha256"];
    delete asset.metadata!["x-goog-meta-copilotz-sha256"];
    await command(prepare, "missing or invalid copilotz-sha256");
    asset.metadata!["x-goog-meta-copilotz-sha256"] = digest;
    await command([
      "prepare",
      `--storage=${storagePath}`,
      `--plan=${planPath}`,
    ]);
    const plan: RetainedDataUpgradePlan = JSON.parse(
      await Deno.readTextFile(planPath),
    );
    assertEquals([plan.sourceVersion, plan.targetVersion], [7, 11]);
    assertEquals(plan.content.inventory.length, 6);
    assert(peak > 1 && peak <= 2, `peak requests: ${peak}`);
    const reviewed = [
      `--plan=${planPath}`,
      `--reviewed=${plan.fingerprint}`,
      `--storage=${storagePath}`,
    ];
    await command(
      ["apply", ...reviewed],
      "requires sourceAdapter and masterAdapter",
    );
    assertEquals(await marker(), 11);
    await command(
      ["apply", ...reviewed, `--owner-keys=${keysPath}`],
      "requires a reviewed authority manifest",
    );
    assertEquals(await marker(), 12);
    await withDb(async (db) => {
      const copies = await readTransferBodies(db, schema);
      assertEquals(copies.length, 6);
      for (const copy of copies) {
        assertEquals(copy.backendKind, "database");
        const original = plan.content.inventory.find((body) =>
          body.bodyId === copy.bodyId
        )!;
        assertEquals(base64ToBytes(copy.bytes), expected.get(original.key));
      }
      const sources = (await db.query<{ state: string; collectable: boolean }>(
        `SELECT state,collectable FROM "${schema}".content_copies WHERE backend_kind='object'`,
      )).rows;
      assertEquals(sources.length, 5);
      assert(
        sources.every((copy) => copy.state === "orphan" && !copy.collectable),
      );
      await Deno.writeTextFile(
        authorityPath,
        JSON.stringify(await testAuthorityManifest(db, schema)),
      );
    });
    const before = f.requests.length;
    assertEquals(
      (await command(["apply", `--authority=${authorityPath}`])).version,
      14,
    );
    assertEquals(await marker(), 14);
    // Replay and final verification need no external source after v12.
    assertEquals(
      (await command(["apply", `--authority=${authorityPath}`])).version,
      14,
    );
    assertEquals(f.requests.length, before);
    assert(peak <= 2);
    for (const [key, object] of f.objects) {
      assertEquals(object.bytes, expected.get(key));
    }
    assert(f.requests.every((r) => r.method === "HEAD" || r.method === "GET"));
  } finally {
    await server.shutdown();
    await withDb(async (db) => {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    });
    await Deno.remove(directory, { recursive: true });
  }
});
