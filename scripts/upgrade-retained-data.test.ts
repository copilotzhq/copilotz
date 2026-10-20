import { assertEquals } from "@std/assert";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { provisionCopilotzSchema } from "../runtime/events/schema.ts";
import { provisionOperationCatalog } from "../runtime/streams/catalog.ts";

Deno.test("offline CLI applies and replays the full reviewed v10 to v13 chain", async () => {
  const directory = await Deno.makeTempDir({ prefix: "chain-cli-" });
  const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ||
    `file://${directory}/db`;
  const schema = `chain_cli_${crypto.randomUUID().replaceAll("-", "")}`;
  const planPath = `${directory}/plan.json`;
  const authorityPath = `${directory}/authority.json`;
  const keysPath = `${directory}/keys.ts`;
  const db = await createTestDatabase({ url });
  try {
    await provisionCopilotzSchema(db, schema);
    await provisionOperationCatalog(db, schema);
    await db.query(
      `UPDATE "${schema}".copilotz_schema_metadata SET version=10`,
    );
  } finally {
    await db.close();
  }
  const command = async (...args: string[]) => {
    const output = await new Deno.Command(Deno.execPath(), {
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
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    return JSON.parse(new TextDecoder().decode(output.stdout));
  };
  try {
    await Deno.writeTextFile(
      keysPath,
      `import { testSecretAdapter } from ${
        JSON.stringify(
          new URL("../runtime/testing/secret-adapter.ts", import.meta.url).href,
        )
      };
const adapter = await testSecretAdapter();
export default { sourceAdapter: adapter, masterAdapter: adapter };
`,
    );
    await Deno.writeTextFile(
      authorityPath,
      JSON.stringify({ policies: [], invocations: [], events: [] }),
    );
    assertEquals((await command("drain")).drained, true);
    const prepared = await command("prepare", `--plan=${planPath}`);
    const plan = JSON.parse(await Deno.readTextFile(planPath));
    assertEquals([plan.sourceVersion, plan.targetVersion], [10, 11]);
    const apply = () =>
      command(
        "apply",
        `--plan=${planPath}`,
        `--reviewed=${prepared.fingerprint}`,
        `--owner-keys=${keysPath}`,
        `--authority=${authorityPath}`,
      );
    assertEquals((await apply()).version, 13);
    assertEquals((await apply()).version, 13);
    assertEquals(await command("authority-inventory"), {
      invocations: [],
      events: [],
    });
  } finally {
    const cleanup = await createTestDatabase({ url });
    try {
      await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await cleanup.close();
      await Deno.remove(directory, { recursive: true });
    }
  }
});
