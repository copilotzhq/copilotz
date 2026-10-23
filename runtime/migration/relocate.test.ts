import { assertEquals, assertRejects } from "@std/assert";
import {
  prepareRetainedDataRestore,
  relocateOwnerSchema,
} from "@copilotz/copilotz/migration";
import { provisionOperationCatalog } from "@copilotz/copilotz/streams";
import { provisionCopilotzSchema } from "@copilotz/copilotz/events";
import { createTestDatabase } from "../testing/ominipg.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";

const selected = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
Deno.test({
  name:
    "public relocation preserves schema identity and source data and refuses overwrite",
  ignore: !selected,
  async fn() {
    const url = new URL(selected!);
    const schema = `relocate_${crypto.randomUUID().replaceAll("-", "")}`;
    const destination = `${url.pathname.slice(1)}_move_${
      crypto.randomUUID().replaceAll("-", "")
    }`;
    const source = await createTestDatabase({ url: selected });
    const adapter = await testSecretAdapter();
    const targetAdapter = await testSecretAdapter();
    const directory = await Deno.makeTempDir();
    let created = false;
    try {
      await provisionCopilotzSchema(source, schema);
      await provisionOperationCatalog(source, schema);
      await prepareRetainedDataRestore({ session: source, schema, adapter });
      await source.query(
        `INSERT INTO "${schema}".nodes(namespace,id,type,name) VALUES('space','retained','record','Retained')`,
      );
      await source.query(`CREATE DATABASE "${destination}"`);
      created = true;
      url.pathname = `/${destination}`;
      const input = {
        sourceUrl: selected!,
        destinationUrl: url.href,
        schema,
        directory: `${directory}/bundle`,
        config: { sourceAdapter: adapter, destinationAdapter: targetAdapter },
      };
      await relocateOwnerSchema(input);
      const target = await createTestDatabase({ url: url.href });
      try {
        const rows =
          `SELECT namespace,id,name FROM "${schema}".nodes WHERE id='retained'`;
        assertEquals(
          (await target.query(rows)).rows,
          (await source.query(rows)).rows,
        );
        const sourceHolder =
          (await source.query(`SELECT holder FROM "${schema}".owner_epochs`))
            .rows;
        const targetHolder =
          (await target.query(`SELECT holder FROM "${schema}".owner_epochs`))
            .rows;
        assertEquals(
          JSON.stringify(sourceHolder) === JSON.stringify(targetHolder),
          false,
        );
        await assertRejects(
          () =>
            relocateOwnerSchema({ ...input, directory: `${directory}/retry` }),
          Error,
          "empty destination schema",
        );
        assertEquals((await target.query(rows)).rows.length, 1);
      } finally {
        await target.close();
      }
    } finally {
      if (created) await source.query(`DROP DATABASE "${destination}"`);
      await source.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await source.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});
