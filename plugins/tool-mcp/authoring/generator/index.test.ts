import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "@copilotz/copilotz/actions";
import type {
  ContentInput,
  ContentRef,
  PreparedContent,
} from "@copilotz/copilotz/content";
import type { MCPServer } from "../../../tools/authoring/integration-resources/index.ts";
import { createMcpToolsPlugin, type McpRuntimeConnection } from "./index.ts";

type Executable = Readonly<{
  execute(input: unknown, context: ActionContext): unknown | Promise<unknown>;
}>;

const server = (overrides: Partial<MCPServer> = {}): MCPServer => ({
  id: "search-server",
  name: "Search Display",
  ...overrides,
});

const context = (
  signal = new AbortController().signal,
  overrides: Partial<ActionContext> = {},
): ActionContext =>
  ({
    namespace: "tenant-a",
    operationKey: "mcp-test",
    identity: {},
    action: {
      id: "copilotz.tools.mcp.search-server.lookup",
      runId: "action-run-a",
      metadata: {},
    },
    signal,
    ...overrides,
  }) as unknown as ActionContext;

Deno.test("MCP factory discovers before composition and executes through native Actions", async () => {
  let connects = 0;
  let closes = 0;
  let called: unknown;
  const plugin = await createMcpToolsPlugin({
    servers: [server()],
    async connect(): Promise<McpRuntimeConnection> {
      connects += 1;
      return {
        listTools: () =>
          Promise.resolve([{
            name: "lookup",
            description: "Look up records.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          }]),
        callTool(name, args, signal) {
          called = { name, args, signal };
          return Promise.resolve({ ok: true });
        },
        close() {
          closes += 1;
        },
      };
    },
  });
  assertEquals(connects, 1);
  assertEquals(closes, 1);
  assertEquals(Object.keys(plugin.actions), ["search_server_lookup"]);
  const resource = plugin.resources.tools.search_server_lookup as {
    action: string;
  };
  assertEquals(resource.action, "search_server_lookup");
  assert(!("execute" in resource));
  const executable = plugin.actions
    .search_server_lookup as unknown as Executable;
  const actionContext = context();
  assertEquals(
    await executable.execute({ query: "contract" }, actionContext),
    { ok: true },
  );
  assertEquals(connects, 2);
  assertEquals(closes, 2);
  assertEquals(called, {
    name: "lookup",
    args: { query: "contract" },
    signal: actionContext.signal,
  });
});

Deno.test("MCP aliases use stable server IDs, honor allowlists, and reject collisions", async () => {
  const connect = (): Promise<McpRuntimeConnection> =>
    Promise.resolve({
      listTools: () =>
        Promise.resolve([
          { name: "allowed" },
          { name: "hidden" },
        ]),
      callTool: () => Promise.resolve(null),
      close() {},
    });
  const plugin = await createMcpToolsPlugin({
    servers: [server({
      name: "Mutable Display Name",
      capabilities: { tools: ["allowed"] },
    })],
    connect,
  });
  assertEquals(Object.keys(plugin.actions), ["search_server_allowed"]);

  await assertRejects(
    () =>
      createMcpToolsPlugin({
        servers: [
          server({ id: "same-server", name: "One" }),
          server({ id: "same_server", name: "Two" }),
        ],
        connect,
      }),
    TypeError,
    "alias collision 'same_server_allowed'",
  );
});

Deno.test("MCP clones and deeply freezes discovered input schemas", async () => {
  const schema = {
    type: "object",
    properties: { query: { type: "string" } },
  };
  const plugin = await createMcpToolsPlugin({
    servers: [server()],
    connect: () =>
      Promise.resolve({
        listTools: () =>
          Promise.resolve([{ name: "isolated", inputSchema: schema }]),
        callTool: () => Promise.resolve(null),
        close() {},
      }),
  });
  schema.properties.query.type = "number";
  const captured = plugin.actions.search_server_isolated.inputSchema as {
    properties: { query: { type: string } };
  };
  assertEquals(captured.properties.query.type, "string");
  assert(Object.isFrozen(captured));
  assert(Object.isFrozen(captured.properties));
  assert(Object.isFrozen(captured.properties.query));

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  class ClientHandle {}
  for (
    const unsafe of [
      { nested: () => "client" },
      { nested: new Uint8Array([1]) },
      { nested: new ClientHandle() },
      { nested: cycle },
    ]
  ) {
    await assertRejects(
      () =>
        createMcpToolsPlugin({
          servers: [server()],
          connect: () =>
            Promise.resolve({
              listTools: () =>
                Promise.resolve([{
                  name: "unsafe-schema",
                  inputSchema: { type: "object", unsafe },
                }]),
              callTool: () => Promise.resolve(null),
              close() {},
            }),
        }),
      TypeError,
    );
  }
});

Deno.test("MCP lowers standard media bodies to canonical lifecycle-safe refs", async () => {
  const raw = {
    content: [
      { type: "text", text: "ready" },
      {
        type: "image",
        data: btoa("image bytes"),
        mimeType: "image/png",
      },
      {
        type: "audio",
        data: btoa("audio bytes"),
        mimeType: "audio/wav",
      },
      {
        type: "resource",
        resource: {
          uri: "file:///report.bin",
          blob: btoa("resource bytes"),
          mimeType: "application/octet-stream",
          name: "report.bin",
        },
      },
    ],
    structuredContent: { count: 3, nested: [true, null, "ok"] },
  };
  const plugin = await createMcpToolsPlugin({
    servers: [server()],
    connect: () =>
      Promise.resolve({
        listTools: () => Promise.resolve([{ name: "media" }]),
        callTool: () => Promise.resolve(raw),
        close() {},
      }),
  });
  const preparedBodies: Array<
    Readonly<{
      type: string;
      body: string;
      mediaType: string;
    }>
  > = [];
  let prepareOperationKey = "";
  let materializeCalls = 0;
  let prepared: PreparedContent | undefined;
  const actionContext = context(undefined, {
    content: {
      prepare(
        input: ContentInput | readonly ContentInput[],
        options: Readonly<{ operationKey: string }>,
      ) {
        prepareOperationKey = options.operationKey;
        const inputs = Array.isArray(input) ? input : [input];
        const refs = inputs.map((candidate, index): ContentRef => {
          if (!("bytes" in candidate)) {
            throw new TypeError("Expected binary MCP content.");
          }
          preparedBodies.push({
            type: candidate.type,
            body: new TextDecoder().decode(candidate.bytes),
            mediaType: candidate.mediaType,
          });
          return {
            assetId: `asset-${index}`,
            kind: candidate.type,
            role: candidate.role ?? "attachment",
            mediaType: candidate.mediaType,
            ...(candidate.disposition
              ? { disposition: candidate.disposition }
              : {}),
            ...(candidate.name ? { name: candidate.name } : {}),
          };
        });
        prepared = { content: refs, assets: [] };
        return Promise.resolve(prepared);
      },
      materialize(input: PreparedContent) {
        materializeCalls += 1;
        assertEquals(input, prepared);
        return Promise.resolve(input.content);
      },
    },
  } as unknown as Partial<ActionContext>);
  const result = await (plugin.actions
    .search_server_media as unknown as Executable).execute(
      {},
      actionContext,
    ) as Record<string, unknown>;
  assertEquals(preparedBodies, [
    {
      type: "image",
      body: "image bytes",
      mediaType: "image/png",
    },
    {
      type: "audio",
      body: "audio bytes",
      mediaType: "audio/wav",
    },
    {
      type: "file",
      body: "resource bytes",
      mediaType: "application/octet-stream",
    },
  ]);
  assertEquals(
    prepareOperationKey,
    "mcp:search-server:media:action-run-a:result-content",
  );
  assertEquals(materializeCalls, 1);
  const content = result.content as Array<Record<string, unknown>>;
  assertEquals(content[0], { type: "text", text: "ready" });
  assertEquals(content[1], {
    type: "image",
    mimeType: "image/png",
    asset: {
      assetId: "asset-0",
      kind: "image",
      role: "tool.output",
      mediaType: "image/png",
      disposition: "attachment",
    } satisfies ContentRef,
  });
  assertEquals(content[2], {
    type: "audio",
    mimeType: "audio/wav",
    asset: {
      assetId: "asset-1",
      kind: "audio",
      role: "tool.output",
      mediaType: "audio/wav",
      disposition: "attachment",
    } satisfies ContentRef,
  });
  assertEquals(content[3], {
    type: "resource",
    resource: {
      uri: "file:///report.bin",
      mimeType: "application/octet-stream",
      name: "report.bin",
      asset: {
        assetId: "asset-2",
        kind: "file",
        role: "tool.output",
        mediaType: "application/octet-stream",
        disposition: "attachment",
        name: "report.bin",
      } satisfies ContentRef,
    },
  });
  assertEquals(JSON.stringify(result).includes("data"), false);
  assertEquals(JSON.stringify(result).includes("blob"), false);
});

Deno.test("MCP rejects non-JSON host values before Action lifecycle output", async () => {
  let raw: unknown = null;
  const plugin = await createMcpToolsPlugin({
    servers: [server()],
    connect: () =>
      Promise.resolve({
        listTools: () => Promise.resolve([{ name: "unsafe" }]),
        callTool: () => Promise.resolve(raw),
        close() {},
      }),
  });
  let prepares = 0;
  let materializes = 0;
  const actionContext = context(undefined, {
    content: {
      prepare() {
        prepares += 1;
        throw new Error("must not prepare");
      },
      materialize() {
        materializes += 1;
        throw new Error("must not materialize");
      },
    },
  } as unknown as Partial<ActionContext>);
  const inherited = Object.assign(Object.create({ inherited: true }), {
    own: true,
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (
    const candidate of [
      new Uint8Array([1, 2, 3]),
      new Blob(["body"]),
      new ReadableStream<Uint8Array>(),
      new Date("2026-08-23T00:00:00.000Z"),
      inherited,
      cycle,
    ]
  ) {
    raw = candidate;
    await assertRejects(
      () =>
        (plugin.actions.search_server_unsafe as unknown as Executable)
          .execute({}, actionContext) as Promise<unknown>,
      TypeError,
    );
  }
  raw = { value: Number.NaN };
  await assertRejects(
    () =>
      (plugin.actions.search_server_unsafe as unknown as Executable)
        .execute({}, actionContext) as Promise<unknown>,
    TypeError,
    "not lossless JSON",
  );
  raw = {
    content: [
      { type: "image", data: btoa("valid"), mimeType: "image/png" },
      { type: "audio", data: "%%%invalid%%%", mimeType: "audio/wav" },
    ],
  };
  await assertRejects(
    () =>
      (plugin.actions.search_server_unsafe as unknown as Executable)
        .execute({}, actionContext) as Promise<unknown>,
  );
  assertEquals(prepares, 0);
  assertEquals(materializes, 0);
});

Deno.test("MCP stages all media before one atomic materialization", async () => {
  const raw = {
    content: [
      { type: "image", data: btoa("one"), mimeType: "image/png" },
      { type: "audio", data: btoa("two"), mimeType: "audio/wav" },
    ],
  };
  const plugin = await createMcpToolsPlugin({
    servers: [server()],
    connect: () =>
      Promise.resolve({
        listTools: () => Promise.resolve([{ name: "atomic" }]),
        callTool: () => Promise.resolve(raw),
        close() {},
      }),
  });
  let preparedInputs = 0;
  let materializeCalls = 0;
  const refs: readonly ContentRef[] = [
    {
      assetId: "asset-one",
      kind: "image",
      role: "tool.output",
      mediaType: "image/png",
    },
    {
      assetId: "asset-two",
      kind: "audio",
      role: "tool.output",
      mediaType: "audio/wav",
    },
  ];
  const prepared: PreparedContent = { content: refs, assets: [] };
  const actionContext = context(undefined, {
    content: {
      prepare(input: ContentInput | readonly ContentInput[]) {
        preparedInputs = Array.isArray(input) ? input.length : 1;
        return Promise.resolve(prepared);
      },
      materialize(input: PreparedContent) {
        materializeCalls += 1;
        assertEquals(input, prepared);
        return Promise.reject(new Error("atomic materialization failed"));
      },
    },
  } as unknown as Partial<ActionContext>);
  await assertRejects(
    () =>
      (plugin.actions.search_server_atomic as unknown as Executable)
        .execute({}, actionContext) as Promise<unknown>,
    Error,
    "atomic materialization failed",
  );
  assertEquals(preparedInputs, 2);
  assertEquals(materializeCalls, 1);
});

Deno.test("MCP discovery and execution close connections on failure and cancellation", async () => {
  let discoveryClosed = 0;
  await assertRejects(
    () =>
      createMcpToolsPlugin({
        servers: [server()],
        connect: () =>
          Promise.resolve({
            listTools: () => Promise.reject(new Error("discovery failed")),
            callTool: () => Promise.resolve(null),
            close() {
              discoveryClosed += 1;
            },
          }),
      }),
    Error,
    "discovery failed",
  );
  assertEquals(discoveryClosed, 1);

  let executionClosed = 0;
  const plugin = await createMcpToolsPlugin({
    servers: [server()],
    connect: () =>
      Promise.resolve({
        listTools: () => Promise.resolve([{ name: "cancel" }]),
        callTool: (_name, _args, signal) =>
          new Promise((_resolve, reject) => {
            if (signal?.aborted) {
              reject(new DOMException("cancelled", "AbortError"));
              return;
            }
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("cancelled", "AbortError")),
              {
                once: true,
              },
            );
          }),
        close() {
          executionClosed += 1;
        },
      }),
  });
  // Ignore the discovery connection close; verify the execution one as well.
  assertEquals(executionClosed, 1);
  const controller = new AbortController();
  const execution =
    (plugin.actions.search_server_cancel as unknown as Executable)
      .execute({}, context(controller.signal));
  controller.abort();
  const error = await assertRejects(async () => await execution);
  assertEquals((error as Error).name, "AbortError");
  assertEquals(executionClosed, 2);
});

Deno.test("MCP preserves the primary failure when connection close also fails", async () => {
  let connections = 0;
  const plugin = await createMcpToolsPlugin({
    servers: [server()],
    connect: () => {
      const connection = ++connections;
      return Promise.resolve({
        listTools: () => Promise.resolve([{ name: "fail" }]),
        callTool: () =>
          Promise.reject(new DOMException("cancelled", "AbortError")),
        close: () => {
          if (connection === 2) {
            return Promise.reject(new Error("close failed"));
          }
        },
      });
    },
  });
  const error = await assertRejects(async () =>
    await (plugin.actions.search_server_fail as unknown as Executable)
      .execute({}, context())
  );
  assertEquals((error as Error).name, "AbortError");

  let successfulConnections = 0;
  const closeFailure = await createMcpToolsPlugin({
    servers: [server()],
    connect: () => {
      const connection = ++successfulConnections;
      return Promise.resolve({
        listTools: () => Promise.resolve([{ name: "success" }]),
        callTool: () => Promise.resolve({ ok: true }),
        close: () => {
          if (connection === 2) {
            throw new Error("close after success");
          }
        },
      });
    },
  });
  await assertRejects(
    async () =>
      await (closeFailure.actions
        .search_server_success as unknown as Executable)
        .execute({}, context()),
    Error,
    "close after success",
  );
});
