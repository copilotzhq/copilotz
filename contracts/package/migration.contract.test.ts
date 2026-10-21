import { assertEquals, assertRejects } from "@std/assert";
import * as migration from "@copilotz/copilotz/migration";
import type {
  OwnerTransferConfig,
  ProtectedBinding,
} from "@copilotz/copilotz/migration";
import { openManagedOminipgDatabase } from "@copilotz/copilotz/persistence";
import { provisionCopilotzSchema } from "@copilotz/copilotz/events";
import { createSecretAdapter } from "@copilotz/copilotz/actions";

Deno.test("migration exposes a reviewed public operator surface", () => {
  assertEquals(Object.keys(migration).sort(), [
    "additionalAuthenticatedData",
    "bodyStoreReader",
    "createContentCatalog",
    "createProtectedValueRuntime",
    "encodeEventBody",
    "exportOwnerBundle",
    "importOwnerBundle",
    "migrateOwnerKeys",
    "oldS3BodyReader",
    "prepareRetainedDataRestore",
    "protectedValueRef",
    "readTransferBodies",
    "relocateOwnerSchema",
  ]);
  const bindings: readonly ProtectedBinding[] = [];
  const transfer: Pick<OwnerTransferConfig, "bindings"> = { bindings };
  assertEquals(transfer.bindings, []);
});

Deno.test("public restore workspace binds storage and key atomically inside an app transaction", async () => {
  const db = await openManagedOminipgDatabase();
  const schema = "public_migration";
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const adapter = createSecretAdapter({
    async seal(input) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      return {
        ciphertext: new Uint8Array(
          await crypto.subtle.encrypt(
            {
              name: "AES-GCM",
              iv,
              additionalData: input.additionalAuthenticatedData as Uint8Array<
                ArrayBuffer
              >,
            },
            key,
            input.plaintext as Uint8Array<ArrayBuffer>,
          ),
        ),
        commitment: "fixture-key-wrap",
        envelope: { iv: [...iv] },
      };
    },
    async open(input) {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: new Uint8Array(input.envelope.iv as number[]),
            additionalData: input.additionalAuthenticatedData as Uint8Array<
              ArrayBuffer
            >,
          },
          key,
          input.ciphertext as Uint8Array<ArrayBuffer>,
        ),
      );
    },
  });
  try {
    await provisionCopilotzSchema(db.session, schema);
    await assertRejects(
      () =>
        db.session.transaction(async (transaction) => {
          await migration.prepareRetainedDataRestore({
            session: { ...transaction, transaction: (run) => run(transaction) },
            schema,
            adapter,
          });
          assertEquals(
            await migration.readTransferBodies(transaction, schema),
            [],
          );
          throw new Error("rollback classified restore");
        }),
      Error,
      "rollback classified restore",
    );
    assertEquals(
      (await db.session.query(`SELECT * FROM "${schema}".owner_data_keys`))
        .rows,
      [],
    );
    const coordinates = { namespace: "space", ownerId: "record", slot: "data" };
    assertEquals(
      JSON.parse(
        new TextDecoder().decode(
          migration.additionalAuthenticatedData(schema, coordinates),
        ),
      ),
      {
        schema: "copilotz.action.protected-value-aad.v1",
        databaseSchema: schema,
        ...coordinates,
      },
    );
    assertEquals(
      (await migration.encodeEventBody({ retained: true })).digest.startsWith(
        "sha256:",
      ),
      true,
    );
  } finally {
    await db.close();
  }
});
