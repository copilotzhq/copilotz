import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import { defineMcp, type McpRuntimeConnection } from "../../index.ts";

Deno.test("one awaited MCP resource discovers once and reuses configuration across apps", async () => {
  let connections = 0;
  let catalogs = 0;
  let closes = 0;
  const docs = await defineMcp({
    id: "docs",
    name: "Docs",
    tools: ["search"],
    connection: {
      transport: { type: "test" },
      async connect(server) {
        connections++;
        assertEquals(server.transport?.type, "test");
        return {
          listTools: async () => {
            catalogs++;
            return [{ name: "search" }];
          },
          callTool: async () => ({ found: true }),
          close() {
            closes++;
          },
        };
      },
    },
  });
  assertEquals([connections, catalogs, closes], [1, 1, 1]);
  const first = createPluginRegistry({ resources: { mcp: { docs } } });
  const second = createPluginRegistry({ resources: { mcp: { docs } } });
  assertEquals(first.actions.docs_search, second.actions.docs_search);
  assertEquals(
    await first.actions.docs_search.execute(
      {},
      {
        adapters: first.adapters,
        signal: new AbortController().signal,
      } as never,
    ),
    { found: true },
  );
  assertEquals([connections, catalogs, closes], [2, 1, 2]);
  assertThrows(
    () =>
      createPluginRegistry({
        resources: { mcp: { docs: Promise.resolve(docs) } },
      }),
    TypeError,
    "await",
  );
});

Deno.test("MCP discovery rejects unknown selections and closes on failure", async () => {
  let closes = 0;
  await assertRejects(
    () =>
      defineMcp({
        id: "docs",
        name: "Docs",
        tools: ["missing"],
        connection: {
          connect: async () => ({
            listTools: async () => [{ name: "search" }],
            callTool: async () => null,
            close() {
              closes++;
            },
          }),
        },
      }),
    TypeError,
    "Unknown MCP tool",
  );
  assertEquals(closes, 1);
});

Deno.test("MCP discovery timeout closes stalled sessions and late connections", async () => {
  let closed = 0;
  await assertRejects(
    () =>
      defineMcp({
        id: "docs",
        name: "Docs",
        timeoutMs: 10,
        connection: {
          connect: async () => ({
            listTools: () => new Promise(() => {}),
            callTool: async () => null,
            close() {
              closed++;
            },
          }),
        },
      }),
    DOMException,
    "timed out",
  );
  assertEquals(closed, 1);
  let finish: (connection: McpRuntimeConnection) => void = () => {};
  await assertRejects(
    () =>
      defineMcp({
        id: "late",
        name: "Late",
        timeoutMs: 10,
        connection: {
          connect: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        },
      }),
    DOMException,
    "timed out",
  );
  finish({
    listTools: async () => [],
    callTool: async () => null,
    close() {
      closed++;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(closed, 2);
});
