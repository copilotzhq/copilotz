import {
  createTestCopilotz as createCopilotz,
  defineTestServerFacade as defineServerFacade,
} from "../runtime/testing/server-authorization.test.ts";
import { assertEquals } from "@std/assert";

import { ActionError, defineAction, secret } from "../runtime/actions/index.ts";
import { definePlugin } from "../runtime/plugins/index.ts";
import { serverPlugin } from "../plugins/server/plugin.ts";

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
      authorization: {
        policies: {
          fixture: {
            revision: "1",
            sources: [],
            evaluate({ authority, intent }) {
              if (intent.resource === "child" && intent.operation !== "admit") {
                throw new ActionError("private-policy-detail", {
                  code: "forbidden",
                  status: 403,
                });
              }
              const facts = authority.requestFacts.input as
                | { path?: string }
                | null;
              if (!resultAllowed && facts?.path?.endsWith("/result")) {
                throw new ActionError("Forbidden", {
                  code: "forbidden",
                  status: 403,
                });
              }
              return {
                actions: { child: {}, root: {} },
                operations: { metadata: {} },
              };
            },
          },
        },
        collections: {},
        actions: {
          child: { id: "fixture", revision: "1" },
          root: { id: "fixture", revision: "1" },
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
                evaluate(request) {
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
      for (const alias of ["child", "root"]) {
        const admitted = await app.fetch(
          new Request(`http://fixture.test/api/actions/${alias}`, {
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
        const body = await result.text();
        assertEquals(result.status, 403, `${alias}: ${body}`);
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
          `SELECT count(*)::int AS n FROM public.event_bodies
           WHERE COALESCE(body->'data',body)->>'actionId'='fixture.denied-child'
             AND (COALESCE(body->'data',body)->>'status' <> 'failed'
               OR COALESCE(body->'data',body)->'input' IS DISTINCT FROM 'null'::jsonb
               OR COALESCE(body->'data',body)->'error'->>'message' <> 'Forbidden')`,
        )).rows[0].n,
        0,
      );
    } finally {
      await app.close();
      await database.close();
    }
  },
});
