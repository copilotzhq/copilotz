/** Portable PostgreSQL owner bundle. Run with intake, owners and producers stopped. */
import { openManagedOminipgDatabase } from "../runtime/persistence/ominipg.ts";
import {
  createCoreTableNames,
  EVENT_SCHEMA_VERSION,
  validateCopilotzSchema,
  validateEventSchemaName,
} from "../runtime/events/schema.ts";
import {
  assertRetainedDataDrained,
  inspectRetainedDataDrain,
} from "../runtime/actions/drain.ts";
import {
  readOwnerDataKey,
  rewrapOwnerDataKey,
  unwrapOwnerDataKey,
  type WrappedOwnerDataKey,
} from "../runtime/actions/owner-data-key.ts";
import type { SecretAdapter } from "../runtime/actions/secret-adapter.ts";
import { digestContent } from "../runtime/content/digest.ts";
import {
  type BodyReader,
  installTransferBodies,
  lockOwnerTables,
  readTransferBodies,
  type TransferBody,
} from "./owner-transfer-storage.ts";
import {
  migrateOwnerKeys,
  type ProtectedBinding,
} from "./migrate-owner-keys.ts";
import { resolve, toFileUrl } from "@std/path";

export type OwnerTransferConfig = {
  sourceAdapter: SecretAdapter;
  destinationAdapter: SecretAdapter;
  readExternalBody?: BodyReader;
  bindings?: readonly ProtectedBinding[];
};
type Bundle = {
  format: "copilotz.owner-bundle.v1";
  schema: string;
  version: number;
  archiveDigest: string;
  bodiesDigest: string;
  key?: WrappedOwnerDataKey;
};
async function pg(command: "pg_dump" | "pg_restore", args: string[]) {
  const result = await new Deno.Command(command, {
    args,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `${command} failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
}
/** pg_dump refuses servers newer than its own major version; say so before any lock. */
async function assertPgDumpSupportsServer(
  session: import("../runtime/events/session.ts").SqlExecutor,
) {
  const server = Math.floor(
    Number(
      (await session.query<{ server_version_num: string }>(
        "SHOW server_version_num",
      )).rows[0].server_version_num,
    ) / 10000,
  );
  const probe = await new Deno.Command("pg_dump", {
    args: ["--version"],
    stdout: "piped",
    stderr: "null",
  }).output().catch(() => undefined);
  const client = Number(
    /\(PostgreSQL\)\s+(\d+)/.exec(
      new TextDecoder().decode(probe?.stdout ?? new Uint8Array()),
    )?.[1],
  );
  if (!probe?.success || !(client >= server)) {
    throw Object.assign(
      new Error(
        `pg_dump ${
          client || "is unavailable and"
        } cannot export a PostgreSQL ${server} server; put pg_dump ${server} or newer on PATH.`,
      ),
      { code: "copilotz_owner_bundle_pg_dump_version", client, server },
    );
  }
}
/** The schema name is preserved: it is part of protected-value authenticated data. */
export async function exportOwnerBundle(input: {
  url: string;
  schema: string;
  directory: string;
  config: OwnerTransferConfig;
}): Promise<void> {
  const schema = validateEventSchemaName(input.schema),
    directory = resolve(input.directory);
  const db = await openManagedOminipgDatabase({ url: input.url });
  try {
    await assertPgDumpSupportsServer(db.session);
    await Deno.mkdir(directory, { mode: 0o700 });
    await db.session.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await lockOwnerTables(tx, schema, "SHARE");
      await validateCopilotzSchema(tx, schema);
      assertRetainedDataDrained(await inspectRetainedDataDrain(tx, schema));
      const bodies = await readTransferBodies(
        tx,
        schema,
        input.config.readExternalBody,
      );
      const key = await readOwnerDataKey(tx, schema);
      if (
        !key && bodies.some((body) =>
          body.mediaType ===
            "application/vnd.copilotz.action-protected-value+json"
        )
      ) throw new Error("Protected owner key is missing.");
      const wrapped = key
        ? await rewrapOwnerDataKey(
          schema,
          key,
          input.config.sourceAdapter,
          input.config.destinationAdapter,
        )
        : undefined;
      const snapshot = (await tx.query<{ snapshot: string }>(
        "SELECT pg_export_snapshot() AS snapshot",
      )).rows[0].snapshot;
      await pg("pg_dump", [
        "--dbname",
        input.url,
        "--schema",
        schema,
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--snapshot",
        snapshot,
        "--exclude-table-data",
        `${schema}.owner_data_keys`,
        "--exclude-table-data",
        `${schema}.copilotz_schema_metadata`,
        "--file",
        `${directory}/schema.dump`,
      ]);
      const bodyBytes = new TextEncoder().encode(JSON.stringify(bodies));
      await Deno.writeFile(`${directory}/bodies.json`, bodyBytes, {
        createNew: true,
        mode: 0o600,
      });
      const manifest: Bundle = {
        format: "copilotz.owner-bundle.v1",
        schema,
        version: EVENT_SCHEMA_VERSION,
        archiveDigest: await digestContent(
          await Deno.readFile(`${directory}/schema.dump`),
        ),
        bodiesDigest: await digestContent(bodyBytes),
        ...(wrapped ? { key: wrapped } : {}),
      };
      await Deno.writeTextFile(
        `${directory}/manifest.json`,
        JSON.stringify(manifest, null, 2) + "\n",
        { createNew: true, mode: 0o600 },
      );
    });
  } finally {
    await db.close();
  }
}
export async function importOwnerBundle(input: {
  url: string;
  directory: string;
  adapter: SecretAdapter;
}): Promise<void> {
  const directory = resolve(input.directory),
    manifest = JSON.parse(
      await Deno.readTextFile(`${directory}/manifest.json`),
    ) as Bundle;
  if (
    manifest.format !== "copilotz.owner-bundle.v1" ||
    manifest.version !== EVENT_SCHEMA_VERSION
  ) throw new Error("Unsupported owner bundle.");
  const schema = validateEventSchemaName(manifest.schema),
    tables = createCoreTableNames(schema);
  const bodyBytes = await Deno.readFile(`${directory}/bodies.json`);
  if (
    await digestContent(await Deno.readFile(`${directory}/schema.dump`)) !==
      manifest.archiveDigest ||
    await digestContent(bodyBytes) !== manifest.bodiesDigest
  ) throw new Error("Owner bundle integrity check failed.");
  const bodies = JSON.parse(
    new TextDecoder().decode(bodyBytes),
  ) as TransferBody[];
  if (manifest.key) {
    const material = await unwrapOwnerDataKey(
      schema,
      manifest.key,
      input.adapter,
    );
    material.fill(0);
  }
  const db = await openManagedOminipgDatabase({ url: input.url });
  try {
    if (
      (await db.session.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema=$1",
        [schema],
      )).rows.length
    ) throw new Error("Import requires an empty destination schema.");
    // No schema marker or key rows are restored: a failed finalization cannot activate.
    await pg("pg_restore", [
      "--dbname",
      input.url,
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      `${directory}/schema.dump`,
    ]);
    await db.session.transaction(async (tx) => {
      await lockOwnerTables(tx, schema, "ACCESS EXCLUSIVE");
      const current = (await tx.query<{ body_id: string }>(
        `SELECT body_id FROM ${tables.content_logical_bodies} b WHERE EXISTS(SELECT 1 FROM ${tables.content_copies} c WHERE c.copy_key=b.current_copy AND c.state='current')`,
      )).rows;
      if (
        current.length !== bodies.length || new Set(bodies.map((body) =>
            body.bodyId
          )).size !== bodies.length ||
        current.some((row) =>
          !bodies.some((body) => body.bodyId === row.body_id)
        )
      ) throw new Error("Bundle body inventory is incomplete.");
      await installTransferBodies(tx, schema, bodies);
      // A restored holder must never attach to a still-live source owner in this process.
      // Preserve the sequence and logical receipts, but invalidate source incarnations.
      await tx.query(
        `UPDATE ${tables.owner_epochs} SET epoch=epoch+1,holder=$1`,
        [crypto.randomUUID()],
      );
      if (manifest.key) {
        await tx.query(
          `INSERT INTO ${tables.owner_data_keys}(singleton,key_id,wrapped_key,envelope) VALUES(TRUE,$1,$2,$3::jsonb)`,
          [
            manifest.key.key_id,
            manifest.key.wrapped_key,
            JSON.stringify(manifest.key.envelope),
          ],
        );
      }
      await tx.query(
        `INSERT INTO ${tables.copilotz_schema_metadata}(singleton,version) VALUES(TRUE,$1)`,
        [EVENT_SCHEMA_VERSION],
      );
      await validateCopilotzSchema(tx, schema);
    });
  } finally {
    await db.close();
  }
}
if (import.meta.main) {
  const [command, ...args] = Deno.args;
  const get = (name: string) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const url = Deno.env.get("COPILOTZ_TRANSFER_DATABASE_URL"),
    configPath = get("config"),
    directory = get("bundle"),
    schema = get("schema");
  if (
    !url || !configPath || !args.includes("--offline") ||
    !["export", "import", "migrate"].includes(command)
  ) {
    throw new Error(
      "Set COPILOTZ_TRANSFER_DATABASE_URL; use export|import|migrate --config=MODULE.ts --offline [--schema=SCHEMA] [--bundle=DIRECTORY]. Stop all owners and producers first.",
    );
  }
  const config = (await import(toFileUrl(resolve(configPath)).href))
    .default as OwnerTransferConfig;
  if (command === "export") {
    if (!schema || !directory) {
      throw new Error("Export requires --schema and --bundle.");
    }
    await exportOwnerBundle({ url, schema, directory, config });
  } else if (command === "import") {
    if (!directory) throw new Error("Import requires --bundle.");
    await importOwnerBundle({
      url,
      directory,
      adapter: config.destinationAdapter,
    });
  } else {
    if (!schema) throw new Error("Migration requires --schema.");
    const db = await openManagedOminipgDatabase({ url });
    try {
      console.log(
        await migrateOwnerKeys({
          session: db.session,
          schema,
          sourceAdapter: config.sourceAdapter,
          masterAdapter: config.destinationAdapter,
          bindings: config.bindings,
          readExternalBody: config.readExternalBody,
        }),
      );
    } finally {
      await db.close();
    }
  }
}
