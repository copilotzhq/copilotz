import { assertEquals, assertRejects } from "@std/assert";
import { defineAction } from "@copilotz/copilotz/actions";
import { definePlugin } from "@copilotz/copilotz/plugins";
import { createCopilotzApplication } from "../runtime/application/index.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { createServerPlugin } from "../plugins/server/index.ts";
import { createServerFacadeFetchHandler } from "./facade.ts";
import { CopilotzHttpError, createCopilotzClient } from "../client/index.ts";

Deno.test("real facade and browser client share durable Action submission and result", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  let executions = 0;
  const echo = defineAction({
    id: "test.echo",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    } as const,
    execute(input: { value: string }) {
      executions++;
      return { echoed: input.value };
    },
  });
  const application = await createCopilotzApplication({
    database,
    namespace: "tenant",
    databaseSchema: "http_client_contract",
    plugins: [
      definePlugin({ id: "test.echo", version: "1", actions: { echo } }),
      createServerPlugin({ expose: { collections: false, channels: false } }),
    ],
  });
  const handler = createServerFacadeFetchHandler(application);
  const client = createCopilotzClient({
    baseUrl: "https://test/api",
    fetch: ((url, init) => handler(new Request(url, init))) as typeof fetch,
  });
  try {
    assertEquals(
      await client.actions.invoke("test.echo", { value: "hello" }, {
        idempotencyKey: "once",
      }),
      { echoed: "hello" },
    );
    assertEquals(
      await client.actions.invoke("test.echo", { value: "hello" }, {
        idempotencyKey: "once",
      }),
      { echoed: "hello" },
    );
    assertEquals(executions, 1);
    await assertRejects(
      () =>
        client.actions.submit("test.echo", { value: "different" }, {
          idempotencyKey: "once",
        }),
      CopilotzHttpError,
    );
    const receipt = await client.actions.submit("test.echo", {
      value: "observe",
    }, { idempotencyKey: "observe" });
    const outputs: string[] = [];
    await client.operations.observe({
      operationIds: [receipt.operationId],
      onFrame(frame) {
        if (frame.kind === "output") outputs.push(frame.output.type);
      },
    });
    assertEquals(outputs.includes("operation.completed"), true);
  } finally {
    await application.close();
    await database.close();
  }
});
