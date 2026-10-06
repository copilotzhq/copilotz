import { assertEquals, assertThrows } from "@std/assert";
import { createPluginRegistry, definePlugin } from "@copilotz/copilotz/plugins";
import { defineTool } from "@copilotz/copilotz/core";
import { defineApi } from "../../index.ts";
const schema = {
  openapi: "3.0.0",
  servers: [{ url: "https://billing.test" }],
  paths: {
    "/customer": { get: { operationId: "getCustomer" } },
    "/hidden": { get: { operationId: "hidden" } },
  },
};

Deno.test("API declarations select and transform tools once with root binding overrides", async () => {
  let transforms = 0;
  const api = defineApi({
    id: "billing",
    name: "Billing",
    schema,
    operations: ["getCustomer"],
    headers: { "X-Default": "yes" },
    transformTool(tool, alias) {
      transforms++;
      assertEquals(alias, "getCustomer");
      return defineTool({
        ...tool.action,
        ...tool.presentation,
        id: "application.customer",
        async execute(input, context) {
          return { wrapped: await tool.action.execute(input, context) };
        },
      });
    },
  });
  const one = definePlugin({
    id: "one",
    version: "1",
    resources: { apis: { billing: api } },
  });
  const two = definePlugin({
    id: "two",
    version: "1",
    resources: { apis: { billing: api } },
  });
  let defaultHeader: string | null = "unset";
  const registry = createPluginRegistry({
    plugins: [one, two],
    adapters: {
      openapi: {
        billing: {
          fetch: ((_url, init) => {
            defaultHeader = new Headers(init?.headers).get("X-Default");
            return Promise.resolve(Response.json({ customer: 1 }));
          }) as typeof fetch,
        },
      },
    },
  });
  assertEquals(transforms, 1);
  assertEquals(registry.actions.getCustomer.id, "application.customer");
  assertEquals("hidden" in registry.actions, false);
  assertEquals(
    await registry.actions.getCustomer.execute(
      {},
      {
        adapters: registry.adapters,
        signal: new AbortController().signal,
        action: { metadata: {}, runId: "test" },
        namespace: "test",
      } as never,
    ),
    { wrapped: { customer: 1 } },
  );
  assertEquals(defaultHeader, null);
  assertThrows(
    () =>
      defineApi({
        id: "invalid",
        name: "Invalid",
        schema,
        operations: ["missing"],
      }),
    TypeError,
    "Unknown API operation",
  );
});

Deno.test("API operation aliases preserve HTTP identity and reject ambiguous registration", async () => {
  let operation = "";
  const api = defineApi({
    id: "aliased",
    name: "Aliased",
    schema,
    aliases: { getCustomer: "customerRead" },
    prepareRequest(request, context) {
      operation = context.actionAlias;
      return request;
    },
  });
  const registry = createPluginRegistry({
    resources: { apis: { aliased: api } },
  });
  await registry.actions.customerRead.execute({}, {
    adapters: {
      openapi: {
        aliased: {
          ...registry.adapters.openapi.aliased,
          fetch: () => Promise.resolve(Response.json({})),
        },
      },
    },
    signal: new AbortController().signal,
    action: { metadata: {}, runId: "test" },
  } as never);
  assertEquals(operation, "getCustomer");
  assertEquals("getCustomer" in registry.actions, false);
  assertThrows(
    () =>
      defineApi({
        id: "bad",
        name: "Bad",
        schema,
        aliases: { getCustomer: "same", hidden: "same" },
      }),
    TypeError,
    "alias collision",
  );
});
