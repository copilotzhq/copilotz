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

Deno.test("SEC3 host cookie adapters discard invalid sessions with matching clearing attributes", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `host_cookie_${crypto.randomUUID().replaceAll("-", "")}`;
  const app = await createTestApplication({
    database: db,
    databaseSchema: schema,
    namespace: "main",
    actions: {
      signIn: defineAction({ id: "sign-in", execute: () => null }),
      privateAction: defineAction({ id: "private", execute: () => null }),
    },
    resources: {
      server: {
        default: defineTestServerFacade({
          sessionCookie: {
            name: "host_session",
            path: "/api",
            domain: "test",
            secure: false,
            sameSite: "Strict",
          },
          expose: { actions: true },
          authenticate(request) {
            if (request.headers.get("cookie") === "host_session=verified") {
              return {
                actor: { id: "valid-host-session" },
                invalidSessionCookie: false,
              };
            }
            return {
              ...(request.headers.has("cookie")
                ? { invalidSessionCookie: true as const }
                : {}),
              ...(request.headers.has("authorization")
                ? { actor: { id: "valid-bearer" } }
                : {}),
            };
          },
          evaluate: () => ({ actions: { signIn: {} } }),
        }),
      },
    },
  });
  const handler = createServerFacadeFetchHandler(app);
  const request = (action: string, headers: Record<string, string>) =>
    handler(
      new Request(`https://test/api/actions/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          ...headers,
        },
        body: "{}",
      }),
    );
  try {
    for (
      const [action, authorization, expected] of [["signIn", false, 202], [
        "privateAction",
        false,
        401,
      ], ["privateAction", true, 403]] as const
    ) {
      const response = await request(action, {
        cookie: "host_session=stale",
        ...(authorization ? { authorization: "Bearer valid" } : {}),
      });
      assertEquals(response.status, expected, await response.clone().text());
      assertEquals(
        response.headers.get("set-cookie"),
        "host_session=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0; Domain=test",
      );
    }
    const valid = await request("signIn", { cookie: "host_session=verified" });
    assertEquals(valid.status, 202, await valid.clone().text());
    assertEquals(valid.headers.get("set-cookie"), null);
    const duplicate = await request("signIn", {
      cookie: "host_session=a; host_session=b",
    });
    assertEquals(duplicate.status, 403);
    assertEquals(
      (await duplicate.json()).error.code,
      "duplicate_session_cookie",
    );
  } finally {
    await app.close();
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
