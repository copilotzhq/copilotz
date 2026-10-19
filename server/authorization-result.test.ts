import { assertEquals } from "@std/assert";
import { createCopilotz } from "../create-copilotz.ts";
import { ActionError, defineAction, secret } from "../runtime/actions/index.ts";
import { definePlugin } from "../runtime/plugins/index.ts";
import { serverPlugin } from "../plugins/server/plugin.ts";
import { defineServerFacade } from "../plugins/server/resources/facade/index.ts";
import { createOwnerTestDatabase } from "../runtime/testing/owner-database.ts";
import { testSecretAdapter } from "../runtime/testing/secret-adapter.ts";
import { until } from "../runtime/testing/effect-commit-proxy.ts";

Deno.test({
  name:
    "HTTP recovers owner refusal before target admission and reauthorizes retained result access",
  ignore: !Deno.env.get("COPILOTZ_OWNER_TEST_POSTGRES_URL"),
  async fn() {
    const database = await createOwnerTestDatabase();
    let executed = 0, resultAllowed = true;
    const child = defineAction({
      id: "fixture.denied-child",
      ownerHooks: { prepareInput: true },
      inputSchema: {
        type: "object",
        properties: { credential: secret({ type: "string" }) },
        additionalProperties: false,
      } as const,
      execute() {
        executed++;
        return "must-not-execute";
      },
    });
    const root = defineAction({
      id: "fixture.denied-root",
      execute: (_input, context) => context.actions.child({}),
    });
    const app = await createCopilotz({
      namespace: "scope",
      database,
      actions: { child, root },
      adapters: { secrets: { default: await testSecretAdapter() } },
      protectedActions: {
        [child.id]: {
          authorize() {
            throw new ActionError("private-policy-detail", {
              code: "forbidden",
              status: 403,
            });
          },
          prepareInput() {
            throw new Error("Denied input must not be prepared");
          },
        },
      },
      plugins: [
        definePlugin({
          ...serverPlugin,
          resources: {
            server: {
              default: defineServerFacade({
                expose: { actions: true, collections: false, channels: false },
                authenticate() {
                  return { actor: { id: "member" } };
                },
                authorize(request) {
                  if (
                    !resultAllowed &&
                    new URL(request.url).pathname.endsWith("/result")
                  ) {
                    return Response.json({
                      error: { code: "forbidden", message: "Forbidden" },
                    }, { status: 403 });
                  }
                  return {};
                },
              }),
            },
          },
        }),
      ],
    });
    try {
      for (const alias of ["denied-child", "denied-root"]) {
        const admitted = await app.fetch(
          new Request(`http://fixture.test/api/actions/fixture/${alias}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": alias,
            },
            body: "{}",
          }),
        );
        assertEquals(admitted.status, 202);
        const receipt = await admitted.json();
        const url =
          `http://fixture.test/api/operations/${receipt.data.operationId}/result`;
        const result = await until(async () => {
          const response = await app.fetch(new Request(url));
          return response.status === 202 ? undefined : response;
        }, "bounded owner refusal result");
        assertEquals(result.status, 403);
        const body = await result.text();
        assertEquals(body.includes("forbidden"), true);
        assertEquals(body.includes("private-policy-detail"), false);
        assertEquals(body.includes("must-not-execute"), false);
        resultAllowed = false;
        const denied = await app.fetch(new Request(url));
        assertEquals(denied.status, 403);
        assertEquals((await denied.json()).error.code, "forbidden");
        resultAllowed = true;
        assertEquals((await app.fetch(new Request(url))).status, 403);
      }
      assertEquals(executed, 0);
      assertEquals(
        (await database.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM public.open_actions",
        )).rows[0].n,
        0,
      );
      assertEquals(
        (await database.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM public.event_bodies WHERE COALESCE(body->'data',body)->>'actionId'='fixture.denied-child'",
        )).rows[0].n,
        0,
      );
    } finally {
      await app.close();
      await database.close();
    }
  },
});
