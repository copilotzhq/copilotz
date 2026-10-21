import { assertEquals } from "@std/assert";
import {
  createTestApplication,
  defineTestServerFacade,
} from "../runtime/testing/server-authorization.test.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { defineAction } from "../runtime/actions/index.ts";
import { coreHttpPlugin } from "../plugins/core-http/index.ts";
import { createServerFacadeFetchHandler } from "./facade.ts";

Deno.test("SEC3 HTTP and Core Actions distinguish absent credentials from denied credentials", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `auth_status_${crypto.randomUUID().replaceAll("-", "")}`;
  const app = await createTestApplication({
    database: db,
    databaseSchema: schema,
    namespace: "main",
    actions: {
      privateAction: defineAction({ id: "private", execute: () => null }),
    },
    plugins: [coreHttpPlugin],
    resources: {
      server: {
        default: defineTestServerFacade({
          expose: { actions: true },
          authenticate(request) {
            if (request.headers.has("x-host-refusal")) {
              return new Response(null, { status: 403 });
            }
            return request.headers.has("x-host-identity")
              ? { actor: { id: "host-member" } }
              : {};
          },
          evaluate: () => ({ actions: {} }),
        }),
      },
    },
  });
  const handler = createServerFacadeFetchHandler(app);
  try {
    for (
      const [action, input] of [["privateAction", {}], ["sendConversation", {
        externalThreadId: "new",
        content: "hello",
      }]] as const
    ) {
      for (
        const headers of [
          {},
          { authorization: "Bearer denied" },
          {
            cookie: "host_session=denied",
          },
          { "x-host-identity": "member" },
          { "x-host-refusal": "true" },
          {
            "x-host-refusal": "true",
            authorization: "Bearer denied",
          },
        ] as Record<string, string>[]
      ) {
        const response = await handler(
          new Request(`http://localhost/api/actions/${action}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": crypto.randomUUID(),
              ...headers,
            },
            body: JSON.stringify(input),
          }),
        );
        assertEquals(
          response.status,
          !Object.keys(headers).length ||
            headers["x-host-refusal"] && !headers.authorization
            ? 401
            : 403,
          await response.text(),
        );
      }
    }
  } finally {
    await app.close();
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
