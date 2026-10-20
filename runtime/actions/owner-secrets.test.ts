import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { readOwnerDataKey, rewrapOwnerDataKey } from "./owner-data-key.ts";
import { createOwnerSecrets } from "./owner-secrets.ts";

Deno.test("owner secrets seal under the owner key, bind their context and move with the owner", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const id = crypto.randomUUID().replaceAll("-", "");
  const schema = `owner_secrets_${id}`, other = `owner_secrets_other_${id}`;
  await provisionCopilotzSchema(db, schema);
  await provisionCopilotzSchema(db, other);
  try {
    const master = await testSecretAdapter();
    const secrets = createOwnerSecrets({ session: db, master });
    const binding = { record: "account-1", field: "accessToken" };

    // Opening never provisions a key.
    await assertRejects(
      () =>
        secrets.open(
          schema,
          JSON.stringify({
            format: "copilotz.owner-secret.v1",
            keyId: "k",
            iv: "AAAAAAAAAAAAAAAA",
            ciphertext: "AA==",
          }),
          binding,
        ),
      Error,
      "not provisioned",
    );
    assertEquals(await readOwnerDataKey(db, schema), undefined);

    // Sealing provisions the key once, through an owner command.
    const sealed = await secrets.seal(schema, "token-value", binding);
    const again = await secrets.seal(schema, "token-value", binding);
    assertNotEquals(sealed, again);
    assertEquals(
      Number(
        (await db.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${
            createCoreTableNames(schema).owner_data_keys
          }`,
        )).rows[0].count,
      ),
      1,
    );
    assertEquals(sealed.includes("token-value"), false);
    assertEquals(await secrets.open(schema, sealed, binding), "token-value");

    // The binding, schema and ciphertext are all authenticated.
    for (
      const changed of [
        { record: "account-2", field: "accessToken" },
        { record: "account-1", field: "refreshToken" },
        { ...binding, extra: "x" },
      ]
    ) await assertRejects(() => secrets.open(schema, sealed, changed));
    await secrets.seal(other, "other", binding);
    await assertRejects(() => secrets.open(other, sealed, binding));
    const parsed = JSON.parse(sealed);
    const flipped = parsed.ciphertext.startsWith("A")
      ? "B" + parsed.ciphertext.slice(1)
      : "A" + parsed.ciphertext.slice(1);
    await assertRejects(() =>
      secrets.open(
        schema,
        JSON.stringify({ ...parsed, ciphertext: flipped }),
        binding,
      )
    );
    await assertRejects(
      () => secrets.seal(schema, "x", {}),
      Error,
      "nonempty",
    );

    // Re-wrapping the owner key for another master leaves sealed values intact.
    const destination = await testSecretAdapter();
    const tables = createCoreTableNames(schema);
    const moved = await rewrapOwnerDataKey(
      schema,
      (await readOwnerDataKey(db, schema))!,
      master,
      destination,
    );
    await db.query(
      `UPDATE ${tables.owner_data_keys} SET wrapped_key=$1, envelope=$2::jsonb WHERE singleton`,
      [moved.wrapped_key, JSON.stringify(moved.envelope)],
    );
    assertEquals(
      await createOwnerSecrets({ session: db, master: destination }).open(
        schema,
        sealed,
        binding,
      ),
      "token-value",
    );
    await assertRejects(() => secrets.open(schema, sealed, binding));
  } finally {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.query(`DROP SCHEMA "${other}" CASCADE`);
    await db.close();
  }
});
