import { defineServerFacade as fixtureServerFacade } from "@copilotz/copilotz/server";
import { definePlugin as defineFixturePlugin } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { definePlugin } from "@copilotz/copilotz/plugins";
import { createCopilotzApplication } from "../../../../runtime/application/index.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { createServerFacadeFetchHandler } from "../../../../server/facade.ts";
import { serverPlugin } from "../../../server/index.ts";
import { usagePlugin } from "../../plugin.ts";
import { createUsageClient } from "../client/index.ts";
import { createUsageHttpAdapter } from "./index.ts";

const FROM = "2026-09-01T00:00:00.000Z";
const TO = "2026-09-02T00:00:00.000Z";

Deno.test("Usage HTTP analytics keeps known zero distinct from unknown and intersects policy", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database,
    namespace: "tenant-a",
    databaseSchema: "usage_http_analytics",
    plugins: [
      defineFixturePlugin({
        ...usagePlugin,
        resources: { usage: { config: { enabled: false } } },
        adapters: { usage: { hooks: { enabled: false } } },
      }),
      definePlugin({
        id: "test.usage.http",
        version: "1",
        adapters: { http: { usage: createUsageHttpAdapter() } },
      }),
      defineFixturePlugin({
        ...serverPlugin,
        resources: {
          server: {
            default: fixtureServerFacade({
              authenticate(request) {
                if (!request.headers.get("authorization")) {
                  return Response.json({ error: { code: "unauthorized" } }, {
                    status: 401,
                  });
                }
                return { namespace: "tenant-a", actor: { id: "reader" } };
              },
              authorize() {
                return {
                  collections: { usage: { where: { threadId: "thread-a" } } },
                };
              },
            }),
          },
        },
      }),
    ],
  });
  const handler = createServerFacadeFetchHandler(application);
  try {
    const usage = application.collections.withScope({ namespace: "tenant-a" })
      .usage;
    const write = (id: string, value: Record<string, unknown>) =>
      usage.create({
        id,
        kind: "llm",
        threadId: "thread-a",
        occurredAt: "2026-09-01T10:00:00.000Z",
        ...value,
      });
    await write("known-zero", {
      status: "completed",
      provider: "openai",
      connection: "primary",
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 100,
    });
    await write("measured-cache", {
      status: "failed",
      provider: "openai",
      connection: "primary",
      inputTokens: 100,
      cachedInputTokens: 50,
      cacheCreationInputTokens: 25,
      totalTokens: 100,
    });
    await write("unknown-cache", {
      status: "cancelled",
      provider: "openai",
      connection: "primary",
      inputTokens: 400,
      totalTokens: 400,
    });
    await usage.create({
      id: "deferred-tool",
      kind: "tool",
      threadId: "thread-a",
      status: "deferred",
      occurredAt: "2026-09-01T11:00:00.000Z",
    });
    await usage.create({
      id: "other-thread",
      kind: "llm",
      threadId: "thread-b",
      status: "completed",
      inputTokens: 999,
      cachedInputTokens: 999,
      occurredAt: "2026-09-01T10:00:00.000Z",
    });
    await usage.create({
      id: "at-exclusive-end",
      kind: "llm",
      threadId: "thread-a",
      status: "completed",
      inputTokens: 777,
      cachedInputTokens: 777,
      occurredAt: TO,
    });
    await application.collections.withScope({ namespace: "tenant-b" }).usage
      .create({
        id: "other-tenant",
        kind: "llm",
        threadId: "thread-a",
        status: "completed",
        inputTokens: 8888,
        cachedInputTokens: 8888,
        occurredAt: "2026-09-01T10:00:00.000Z",
      });

    const unauthenticated = await handler(
      new Request(
        `https://fixture/api/usage?kind=llm&from=${
          encodeURIComponent(FROM)
        }&to=${encodeURIComponent(TO)}`,
      ),
    );
    assertEquals(unauthenticated.status, 401);
    const client = createUsageClient({
      baseUrl: "https://fixture/api/usage",
      getRequestHeaders: () => ({ authorization: "Bearer test" }),
      fetch: ((url, init) => handler(new Request(url, init))) as typeof fetch,
    });
    const analytics = await client.analytics({
      filters: { kind: "llm", from: FROM, to: TO },
      groupBy: ["provider", "connection"],
    });
    assertEquals(analytics.summary.attempts, 3);
    assertEquals(analytics.summary.completed, 1);
    assertEquals(analytics.summary.failed, 1);
    assertEquals(analytics.summary.cancelled, 1);
    assertEquals(analytics.summary.cachedInputTokens, 50);
    assertEquals(analytics.summary.cacheCreationInputTokens, 25);
    assertEquals(analytics.summary.cacheMeasuredInputTokens, 200);
    assertEquals(analytics.summary.cacheMeasuredReadTokens, 50);
    assertEquals(analytics.summary.cacheReuse, 0.25);
    assertEquals(analytics.summary.cacheCoverage, 2 / 3);
    assertEquals(analytics.summary.durationMs, null);
    assertEquals(analytics.breakdown.length, 1);
    assertEquals(analytics.breakdown[0].attempts, analytics.summary.attempts);
    assertEquals(analytics.series[0].attempts, analytics.summary.attempts);

    const inaccessibleThread = await client.analytics({
      filters: { kind: "llm", from: FROM, to: TO, threadId: "thread-b" },
    });
    assertEquals(inaccessibleThread.summary.attempts, 0);

    const firstAttempts = await handler(
      new Request(
        `https://fixture/api/usage/attempts?kind=llm&from=${
          encodeURIComponent(FROM)
        }&to=${encodeURIComponent(TO)}&limit=2`,
        { headers: { authorization: "Bearer test" } },
      ),
    );
    assertEquals(firstAttempts.status, 200);
    const firstPage = await firstAttempts.json();
    assertEquals(firstPage.items.length, 2);
    assertEquals(firstPage.pageInfo.hasMore, true);
    assertEquals(typeof firstPage.pageInfo.next, "string");
    assertEquals(
      firstPage.items.every((item: { threadId: string }) =>
        item.threadId === "thread-a"
      ),
      true,
    );
    const secondAttempts = await handler(
      new Request(
        `https://fixture/api/usage/attempts?kind=llm&from=${
          encodeURIComponent(FROM)
        }&to=${encodeURIComponent(TO)}&limit=2&after=${
          encodeURIComponent(firstPage.pageInfo.next)
        }`,
        { headers: { authorization: "Bearer test" } },
      ),
    );
    const secondPage = await secondAttempts.json();
    assertEquals(secondPage.items.length, 1);
    assertEquals(secondPage.pageInfo.hasMore, false);
    const foreignCursor = await handler(
      new Request(
        `https://fixture/api/usage/attempts?kind=llm&from=${
          encodeURIComponent(FROM)
        }&to=${encodeURIComponent(TO)}&after=other-thread`,
        { headers: { authorization: "Bearer test" } },
      ),
    );
    assertEquals(foreignCursor.status, 400);

    const tools = await handler(
      new Request(
        `https://fixture/api/usage?kind=tool&from=${
          encodeURIComponent(FROM)
        }&to=${encodeURIComponent(TO)}`,
        { headers: { authorization: "Bearer test" } },
      ),
    );
    assertEquals((await tools.json()).summary.deferred, 1);
    const forged = await handler(
      new Request(
        `https://fixture/api/usage?kind=llm&namespace=tenant-b&from=${
          encodeURIComponent(FROM)
        }&to=${encodeURIComponent(TO)}`,
        { headers: { authorization: "Bearer test" } },
      ),
    );
    assertEquals(forged.status, 400);
    const duplicate = await handler(
      new Request(
        "https://fixture/api/usage?kind=llm&kind=tool",
        { headers: { authorization: "test" } },
      ),
    );
    assertEquals(duplicate.status, 400);
  } finally {
    await application.close();
    await database.close();
  }
});
