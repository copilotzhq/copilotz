import {
  type ActionContext,
  ActionError,
  defineAction,
} from "../actions/index.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { createFixtureCopilotz as createCopilotz } from "../testing/fixture-commands.test.ts";
import { definePlugin } from "../plugins/index.ts";
import { serverPlugin } from "../../plugins/server/plugin.ts";
import { defineServerFacade } from "../../plugins/server/resources/facade/index.ts";
import type { HttpReadServices } from "../../plugins/server/authoring/http-adapter/index.ts";
import { defineCollection } from "./definition.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { until } from "../testing/effect-commit-proxy.ts";

Deno.test("protected Collection authentication lookup is owner-only and cannot escape to HTTP", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    pgPoolMax: 4,
  });
  const schema = `policy_http_${crypto.randomUUID().replaceAll("-", "")}`;
  let lookup: HttpReadServices | undefined;
  let authenticated = 0;
  const entry = defineCollection({
    name: "privateEntry",
    ownerPolicy: "required",
    schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    } as const,
  });
  const app = await createCopilotz({
    database: db,
    databaseSchema: schema,
    namespace: "space",
    collections: { entry },
    actions: {
      read: defineAction({
        id: "fixture.denied-read",
        async execute(_input: unknown, context: ActionContext) {
          return await context.collections.entry.get({ id: "secret" });
        },
      }),
    },
    collectionPolicies: {
      entry: {
        authorize() {
          throw new ActionError("Private fixture record denied", {
            code: "forbidden",
            status: 403,
          });
        },
      },
    },
    plugins: [
      definePlugin({
        ...serverPlugin,
        resources: {
          server: {
            default: defineServerFacade({
              expose: { actions: true, collections: true, channels: false },
              async authenticate(_request, context) {
                lookup = await context.lookup({
                  namespace: "space",
                  databaseSchema: schema,
                });
                const row = await lookup.get("entry", "secret");
                assertEquals(row?.value, "owner-only");
                authenticated++;
                return { actor: { id: "member" } };
              },
              authorize() {
                return {};
              },
            }),
          },
        },
      }),
    ],
    hostCommands: {
      seed: {
        namespace: "space",
        principal: "fixture",
        authorize() {},
        async execute(_input: unknown, context) {
          await context.query(
            `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) VALUES('secret','space','privateEntry','secret','{"value":"owner-only"}'::jsonb)`,
          );
          return true;
        },
      },
    },
  });
  try {
    await app.hostCommands.invoke("seed", null);
    const response = await app.fetch(
      new Request("http://fixture.test/api/collections/privateEntry/secret", {
        headers: { "x-principal": "member", "x-invocation-kind": "alarm" },
      }),
    );
    assertEquals(authenticated, 1);
    assertEquals(response.status, 403);
    const body = await response.text();
    assertEquals(body.includes("owner-only"), false);
    const actionResponse = await app.fetch(
      new Request("http://fixture.test/api/actions/fixture/denied-read", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "denied-read",
        },
        body: JSON.stringify({ input: {} }),
      }),
    );
    assertEquals(actionResponse.status, 202);
    const receipt = await actionResponse.json();
    const resultResponse = await until(async () => {
      const response = await app.fetch(
        new Request(
          `http://fixture.test/api/operations/${receipt.data.operationId}/result`,
        ),
      );
      return response.status === 202 ? undefined : response;
    }, "HTTP Action policy refusal");
    assertEquals(resultResponse.status, 403);
    const actionBody = await resultResponse.text();
    assertEquals(actionBody.includes("owner-only"), false);
    assertEquals(actionBody.includes("forbidden"), true);
    await assertRejects(() => lookup!.get("entry", "secret"));
    await assertRejects(() => lookup!.list("entry", {}));
    await assertRejects(() => app.collections.entry.get({ id: "secret" }));
  } finally {
    await app.close();
    await db.close();
  }
});
