import { assert, assertEquals, assertRejects } from "@std/assert";
import { createCopilotzApplication } from "../application/application.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { defineAction } from "./define.ts";
import { secret } from "./secret.ts";
const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
Deno.test({
  name:
    "owner-prepared public coordinates pass both metadata scans while actual and equal token leaks fail",
  ignore: !url,
  async fn() {
    const database = await createTestDatabase({ url, pgPoolMax: 1 });
    const schema = `public_scalars_${crypto.randomUUID().replaceAll("-", "")}`;
    let executed = 0, adopted = 0;
    const action = defineAction({
      id: "fixture.public-scalars",
      ownerHooks: { prepareInput: true, acceptOutput: true },
      inputSchema: {
        type: "object",
        properties: {
          equal: { type: "boolean" },
          credential: secret({
            type: "object",
            properties: {
              ownerId: { type: "string", "x-copilotz-secret": false },
              kind: { type: "string", "x-copilotz-secret": false },
              token: { type: "string" },
            },
            additionalProperties: false,
          }),
        },
        additionalProperties: false,
      } as const,
      outputSchema: { type: "boolean" } as const,
      execute() {
        executed++;
        return true;
      },
    });
    const app = await createCopilotzApplication({
      database,
      databaseSchema: schema,
      namespace: "public",
      actions: { use: action },
      adapters: { secrets: { default: await testSecretAdapter() } },
      protectedActions: {
        [action.id]: {
          authorize() {},
          prepareInput(input) {
            return {
              ...(input as object),
              credential: {
                ownerId: "public",
                kind: "start",
                token: (input as { equal?: boolean }).equal
                  ? "public"
                  : "synthetic-private-token",
              },
            };
          },
          acceptOutput() {
            adopted++;
          },
        },
      },
    });
    try {
      assertEquals(
        await app.host.actions.use({}, {
          idempotencyKey: "allowed",
          actionMetadata: {
            namespace: "public",
            route: "fixture.google-start",
          },
        }),
        true,
      );
      await assertRejects(() =>
        app.host.actions.use({}, {
          idempotencyKey: "token-leak",
          actionMetadata: { stolen: "synthetic-private-token" },
        })
      );
      await assertRejects(() =>
        app.host.actions.use({ equal: true }, {
          idempotencyKey: "equal-leak",
          actionMetadata: { namespace: "public" },
        })
      );
      assertEquals(executed, 1);
      assertEquals(adopted, 1);
      const rows = await database.query(
        `SELECT intent,result FROM "${schema}".owner_receipts`,
      );
      assert(!JSON.stringify(rows.rows).includes("synthetic-private-token"));
    } finally {
      await app.close();
      await database.close();
    }
  },
});
