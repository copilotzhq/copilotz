import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { ActionContext } from "@copilotz/copilotz/actions";
import type {
  ContentRef,
  PreparedContent,
  PublishAssetInput,
} from "@copilotz/copilotz/content";
import type {
  ContentStreamAppendInput,
  ContentStreamOpenInput,
} from "@copilotz/copilotz/streams";
import type { API } from "../resources.ts";
import { createOpenApiToolsPlugin, defineApi } from "./generator.ts";

type Executable = Readonly<{
  execute(input: unknown, context: ActionContext): unknown | Promise<unknown>;
}>;

function action(
  plugin: ReturnType<typeof createOpenApiToolsPlugin>,
  alias: string,
): Executable {
  const value = plugin.actions[alias];
  if (!value) throw new Error(`Missing generated Action '${alias}'.`);
  return value as unknown as Executable;
}

function actionContext(
  overrides: Partial<ActionContext> = {},
): ActionContext {
  return {
    namespace: "tenant-a",
    operationKey: "openapi-test",
    identity: { correlationId: "correlation-a" },
    action: {
      id: "copilotz.tools.openapi.fixture.operation",
      runId: "action-run-a",
      metadata: { caller: "test" },
    },
    collections: {},
    content: {},
    streams: {},
    signal: new AbortController().signal,
    ...overrides,
  } as unknown as ActionContext;
}

function api(
  operationId: string,
  options: Partial<API> = {},
): API {
  return {
    id: "fixture-api",
    name: "Fixture API",
    baseUrl: "https://example.test",
    openApiSchema: {
      openapi: "3.1.0",
      paths: {
        "/operation": {
          post: {
            operationId,
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: {} },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    },
    ...options,
  };
}

Deno.test("OpenAPI factory injects native Action context into request preparation", async () => {
  let observed:
    | Parameters<NonNullable<API["prepareRequest"]>>[1]
    | undefined;
  const definition = api("scoped_lookup", {
    prepareRequest(request, context) {
      observed = context;
      return request;
    },
  });
  const collection = Object.freeze({ definition: { name: "records" } });
  const context = actionContext({
    collections: { records: collection } as unknown as ActionContext[
      "collections"
    ],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(Response.json({ ok: true }));
  try {
    const plugin = createOpenApiToolsPlugin({ apis: [definition] });
    await action(plugin, "scoped_lookup").execute({}, context);
    assertEquals(observed?.apiId, "fixture-api");
    assertEquals(observed?.actionAlias, "scoped_lookup");
    assertEquals(observed?.actionRunId, "action-run-a");
    assertStrictEquals(observed?.signal, context.signal);
    assertEquals(observed?.namespace, "tenant-a");
    assertStrictEquals(observed?.collections.records, collection as never);
    assertEquals(Object.keys(plugin.actions), ["scoped_lookup"]);
    assertEquals(
      (plugin.resources.tools.scoped_lookup as { action: string }).action,
      "scoped_lookup",
    );
    assert(!("execute" in (plugin.resources.tools.scoped_lookup as object)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAPI NDJSON uses live Content Streams and materializes them before completion", async () => {
  const definition = api("terminal", { streamNdjson: true });
  const seen: unknown[] = [];
  const ref: ContentRef = {
    assetId: "stream-asset-a",
    kind: "text",
    role: "tool.output",
    mediaType: "text/plain",
  };
  const prepared: PreparedContent = { content: [ref], assets: [] };
  const context = actionContext({
    streams: {
      async open(input: ContentStreamOpenInput) {
        seen.push({ type: "open", input });
        return {
          id: input.id ?? "stream-a",
          offset: () => 0,
          async append(value: ContentStreamAppendInput) {
            seen.push({
              type: "append",
              value: new TextDecoder().decode(value.bytes),
            });
            return { startOffset: 0, endOffset: value.bytes.byteLength };
          },
          async close() {
            seen.push({ type: "close" });
            return prepared;
          },
          async abort() {},
          async [Symbol.asyncDispose]() {},
        };
      },
      follow() {
        throw new Error("not used");
      },
    },
    content: {
      materialize(value: PreparedContent) {
        assertEquals(value, prepared);
        seen.push({ type: "materialize" });
        return Promise.resolve(value.content);
      },
    },
  } as unknown as Partial<ActionContext>);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        [
          JSON.stringify({
            type: "output",
            channel: "stdout",
            mode: "append",
            delta: "hello\n",
          }),
          JSON.stringify({ type: "result", value: { exitCode: 0 } }),
          "",
        ].join("\n"),
        { headers: { "content-type": "application/x-ndjson" } },
      ),
    );
  try {
    const result = await action(
      createOpenApiToolsPlugin({ apis: [definition] }),
      "terminal",
    ).execute({}, context);
    assertEquals(result, {
      exitCode: 0,
      streams: { stdout: ref },
    });
    assertEquals(seen.map((entry) => (entry as { type: string }).type), [
      "open",
      "append",
      "close",
      "materialize",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAPI NDJSON aborts every open stream on missing and error terminals", async () => {
  const definition = api("terminal_failure", { streamNdjson: true });
  const originalFetch = globalThis.fetch;
  try {
    for (
      const terminal of [
        "",
        JSON.stringify({ type: "error", error: { message: "failed" } }),
      ]
    ) {
      let aborts = 0;
      const context = actionContext({
        streams: {
          async open(input: ContentStreamOpenInput) {
            return {
              id: input.id ?? "stream-a",
              offset: () => 0,
              append: () => Promise.resolve({ startOffset: 0, endOffset: 1 }),
              close: () => Promise.resolve({ content: [], assets: [] }),
              abort: () => {
                aborts += 1;
                return Promise.resolve();
              },
              async [Symbol.asyncDispose]() {},
            };
          },
          follow() {
            throw new Error("not used");
          },
        },
      } as unknown as Partial<ActionContext>);
      globalThis.fetch = () =>
        Promise.resolve(
          new Response(
            [
              JSON.stringify({
                type: "output",
                channel: "stdout",
                delta: "partial",
              }),
              terminal,
              "",
            ].join("\n"),
            {
              headers: { "content-type": "application/x-ndjson" },
            },
          ),
        );
      await assertRejects(async () =>
        await action(
          createOpenApiToolsPlugin({ apis: [definition] }),
          "terminal_failure",
        ).execute({}, context)
      );
      assertEquals(aborts, 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAPI NDJSON close failure aborts that and every later writer", async () => {
  const definition = api("terminal_close_failure", { streamNdjson: true });
  const states = new Map<string, { closes: number; aborts: number }>();
  let materializeCalls = 0;
  const context = actionContext({
    streams: {
      async open(input: ContentStreamOpenInput) {
        const channel = String(input.metadata?.channel);
        const state = { closes: 0, aborts: 0 };
        states.set(channel, state);
        return {
          id: input.id ?? channel,
          offset: () => 0,
          append: () => Promise.resolve({ startOffset: 0, endOffset: 1 }),
          close: () => {
            state.closes += 1;
            if (channel === "stderr") {
              return Promise.reject(new Error("close failed"));
            }
            return Promise.resolve({ content: [], assets: [] });
          },
          abort: () => {
            state.aborts += 1;
            return Promise.resolve();
          },
          async [Symbol.asyncDispose]() {},
        };
      },
      follow() {
        throw new Error("not used");
      },
    },
    content: {
      materialize: () => {
        materializeCalls += 1;
        return Promise.resolve([]);
      },
    },
  } as unknown as Partial<ActionContext>);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        [
          JSON.stringify({ type: "output", channel: "stdout", delta: "one" }),
          JSON.stringify({ type: "output", channel: "stderr", delta: "two" }),
          JSON.stringify({ type: "output", channel: "trace", delta: "three" }),
          JSON.stringify({ type: "result", value: { exitCode: 0 } }),
          "",
        ].join("\n"),
        {
          headers: { "content-type": "application/x-ndjson" },
        },
      ),
    );
  try {
    await assertRejects(
      async () =>
        await action(
          createOpenApiToolsPlugin({ apis: [definition] }),
          "terminal_close_failure",
        ).execute({}, context),
      Error,
      "close failed",
    );
    assertEquals(
      states,
      new Map([
        ["stdout", { closes: 1, aborts: 0 }],
        ["stderr", { closes: 1, aborts: 1 }],
        ["trace", { closes: 0, aborts: 1 }],
      ]),
    );
    assertEquals(materializeCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAPI NDJSON materializes all closed channels in one batch", async () => {
  const definition = api("terminal_combined", { streamNdjson: true });
  const refs: Record<string, ContentRef> = {
    stdout: {
      assetId: "stream-stdout",
      kind: "text",
      role: "tool.output",
      mediaType: "text/plain",
    },
    stderr: {
      assetId: "stream-stderr",
      kind: "text",
      role: "tool.output",
      mediaType: "text/plain",
    },
  };
  const assets = Object.fromEntries(
    Object.entries(refs).map(([channel, ref]) => [channel, {
      id: ref.assetId,
      namespace: "tenant-a",
      mediaType: ref.mediaType,
      body: new TextEncoder().encode(channel),
      byteLength: channel.length,
      digest: `sha256:${channel}` as const,
    }]),
  );
  let materializeCalls = 0;
  const context = actionContext({
    streams: {
      async open(input: ContentStreamOpenInput) {
        const channel = String(input.metadata?.channel);
        return {
          id: input.id ?? channel,
          offset: () => 0,
          append: () => Promise.resolve({ startOffset: 0, endOffset: 1 }),
          close: () =>
            Promise.resolve({
              content: [refs[channel]],
              assets: [assets[channel]],
            }),
          abort: () => Promise.resolve(),
          async [Symbol.asyncDispose]() {},
        };
      },
      follow() {
        throw new Error("not used");
      },
    },
    content: {
      materialize(prepared: PreparedContent) {
        materializeCalls += 1;
        assertEquals(prepared.content, [refs.stdout, refs.stderr]);
        assertEquals(prepared.assets, [assets.stdout, assets.stderr]);
        return Promise.resolve(prepared.content);
      },
    },
  } as unknown as Partial<ActionContext>);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        [
          JSON.stringify({ type: "output", channel: "stdout", delta: "one" }),
          JSON.stringify({ type: "output", channel: "stderr", delta: "two" }),
          JSON.stringify({ type: "result", value: { exitCode: 0 } }),
          "",
        ].join("\n"),
        { headers: { "content-type": "application/x-ndjson" } },
      ),
    );
  try {
    const result = await action(
      createOpenApiToolsPlugin({ apis: [definition] }),
      "terminal_combined",
    ).execute({}, context);
    assertEquals(materializeCalls, 1);
    assertEquals(result, {
      exitCode: 0,
      streams: { stdout: refs.stdout, stderr: refs.stderr },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAPI NDJSON settles all writers before one failing materialization", async () => {
  const definition = api("terminal_materialize_failure", {
    streamNdjson: true,
  });
  let closes = 0;
  let materializeCalls = 0;
  const context = actionContext({
    streams: {
      async open(input: ContentStreamOpenInput) {
        const channel = String(input.metadata?.channel);
        const ref: ContentRef = {
          assetId: `stream-${channel}`,
          kind: "text",
          role: "tool.output",
          mediaType: "text/plain",
        };
        return {
          id: input.id ?? channel,
          offset: () => 0,
          append: () => Promise.resolve({ startOffset: 0, endOffset: 1 }),
          close: () => {
            closes += 1;
            return Promise.resolve({ content: [ref], assets: [] });
          },
          abort: () => Promise.resolve(),
          async [Symbol.asyncDispose]() {},
        };
      },
      follow() {
        throw new Error("not used");
      },
    },
    content: {
      materialize(prepared: PreparedContent) {
        materializeCalls += 1;
        assertEquals(prepared.content.length, 2);
        return Promise.reject(new Error("materialize failed"));
      },
    },
  } as unknown as Partial<ActionContext>);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        [
          JSON.stringify({ type: "output", channel: "stdout", delta: "one" }),
          JSON.stringify({ type: "output", channel: "stderr", delta: "two" }),
          JSON.stringify({ type: "result", value: {} }),
          "",
        ].join("\n"),
        { headers: { "content-type": "application/x-ndjson" } },
      ),
    );
  try {
    await assertRejects(
      () =>
        action(
          createOpenApiToolsPlugin({ apis: [definition] }),
          "terminal_materialize_failure",
        ).execute({}, context) as Promise<unknown>,
      Error,
      "materialize failed",
    );
    assertEquals(closes, 2);
    assertEquals(materializeCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAPI NDJSON requires exactly one ref from every closed channel", async () => {
  const definition = api("terminal_invalid_close", { streamNdjson: true });
  let materializeCalls = 0;
  const context = actionContext({
    streams: {
      async open(input: ContentStreamOpenInput) {
        return {
          id: input.id ?? "stream-a",
          offset: () => 0,
          append: () => Promise.resolve({ startOffset: 0, endOffset: 1 }),
          close: () => Promise.resolve({ content: [], assets: [] }),
          abort: () => Promise.resolve(),
          async [Symbol.asyncDispose]() {},
        };
      },
      follow() {
        throw new Error("not used");
      },
    },
    content: {
      materialize() {
        materializeCalls += 1;
        return Promise.resolve([]);
      },
    },
  } as unknown as Partial<ActionContext>);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        [
          JSON.stringify({ type: "output", channel: "stdout", delta: "one" }),
          JSON.stringify({ type: "result", value: {} }),
          "",
        ].join("\n"),
        { headers: { "content-type": "application/x-ndjson" } },
      ),
    );
  try {
    await assertRejects(
      () =>
        action(
          createOpenApiToolsPlugin({ apis: [definition] }),
          "terminal_invalid_close",
        ).execute({}, context) as Promise<unknown>,
      TypeError,
      "exactly one ContentRef",
    );
    assertEquals(materializeCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAPI NDJSON rejects non-append and inconsistent channel declarations", async () => {
  const definition = api("terminal_invalid_output", { streamNdjson: true });
  const cases = [
    {
      records: [
        { type: "output", channel: "stdout", mode: "replace", delta: "one" },
      ],
      message: "mode 'replace' is unsupported",
      opens: 0,
    },
    {
      records: [
        {
          type: "output",
          channel: "stdout",
          mediaType: "text/plain",
          delta: "one",
        },
        {
          type: "output",
          channel: "stdout",
          mediaType: "application/json",
          delta: "two",
        },
      ],
      message: "changed mediaType",
      opens: 1,
    },
    {
      records: [
        { type: "output", channel: "a-b", delta: "one" },
        { type: "output", channel: "a_b", delta: "two" },
      ],
      message: "produce the same stream ID",
      opens: 1,
    },
  ] as const;
  const originalFetch = globalThis.fetch;
  try {
    for (const testCase of cases) {
      let opens = 0;
      const context = actionContext({
        streams: {
          async open(input: ContentStreamOpenInput) {
            opens += 1;
            return {
              id: input.id ?? "stream-a",
              offset: () => 0,
              append: () => Promise.resolve({ startOffset: 0, endOffset: 1 }),
              close: () => Promise.resolve({ content: [], assets: [] }),
              abort: () => Promise.resolve(),
              async [Symbol.asyncDispose]() {},
            };
          },
          follow() {
            throw new Error("not used");
          },
        },
      } as unknown as Partial<ActionContext>);
      globalThis.fetch = () =>
        Promise.resolve(
          new Response(
            [...testCase.records, { type: "result", value: {} }]
              .map((record) => JSON.stringify(record)).join("\n") + "\n",
            { headers: { "content-type": "application/x-ndjson" } },
          ),
        );
      await assertRejects(
        () =>
          action(
            createOpenApiToolsPlugin({ apis: [definition] }),
            "terminal_invalid_output",
          ).execute({}, context) as Promise<unknown>,
        TypeError,
        testCase.message,
      );
      assertEquals(opens, testCase.opens);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAPI response assets publish canonical content and return a ContentRef", async () => {
  const definition = api("asset_export", {
    responseAssets: {
      asset_export: {
        dataBase64Field: "dataBase64",
        mediaTypeField: "mimeType",
        nameField: "path",
      },
    },
  });
  let published = "";
  const context = actionContext({
    content: {
      publish(input: Omit<PublishAssetInput, "namespace" | "idempotencyKey">) {
        published = new TextDecoder().decode(input.body);
        return Promise.resolve({
          id: "asset-a",
          namespace: "tenant-a",
          mediaType: input.mediaType,
          byteLength: input.body.byteLength,
          digest: "sha256:fixture",
          state: "ready",
          location: { kind: "database", key: "asset-a" },
          createdAt: "2026-08-23T00:00:00.000Z",
        });
      },
    },
  } as unknown as Partial<ActionContext>);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(Response.json({
      path: "outputs/report.csv",
      mimeType: "text/csv",
      dataBase64: btoa("name,value\nalpha,1\n"),
    }));
  try {
    const result = await action(
      createOpenApiToolsPlugin({ apis: [definition] }),
      "asset_export",
    ).execute({}, context);
    assertEquals(published, "name,value\nalpha,1\n");
    assertEquals(result, {
      path: "outputs/report.csv",
      mimeType: "text/csv",
      asset: {
        assetId: "asset-a",
        kind: "file",
        role: "attachment",
        mediaType: "text/csv",
        disposition: "attachment",
        name: "report.csv",
      },
    });
    assertEquals(JSON.stringify(result).includes("dataBase64"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAPI response assets promote explicit data URLs as one ref per field", async () => {
  const definition = api("available_seats", {
    responseAssets: {
      available_seats: [
        {
          dataUrlField: "seatMapImg",
          outputField: "seatMapAsset",
          mediaTypes: ["image/*"],
        },
        {
          dataUrlField: "secondFloorSeatMapImg",
          outputField: "secondFloorSeatMapAsset",
          mediaTypes: ["image/png"],
          optional: true,
        },
      ],
    },
  });
  const published: Array<
    Readonly<{
      bytes: string;
      mediaType: string;
      operationKey: string;
    }>
  > = [];
  const context = actionContext({
    content: {
      publish(
        input: Omit<PublishAssetInput, "namespace" | "idempotencyKey">,
        options: Readonly<{ operationKey: string }>,
      ) {
        published.push(Object.freeze({
          bytes: new TextDecoder().decode(input.body),
          mediaType: input.mediaType,
          operationKey: options.operationKey,
        }));
        const id = `asset-${published.length}`;
        return Promise.resolve({
          id,
          namespace: "tenant-a",
          mediaType: input.mediaType,
          byteLength: input.body.byteLength,
          digest: `sha256:${id}`,
          state: "ready",
          location: { kind: "database", key: id },
          createdAt: "2026-08-23T00:00:00.000Z",
        });
      },
    },
  } as unknown as Partial<ActionContext>);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(Response.json({
      availableSeats: ["01", "02"],
      seatMapImg: `data:image/png;base64,${btoa("floor-one")}`,
      secondFloorSeatMapImg: `data:image/png;base64,${btoa("floor-two")}`,
    }));
  try {
    const result = await action(
      createOpenApiToolsPlugin({ apis: [definition] }),
      "available_seats",
    ).execute({}, context);
    assertEquals(published, [
      {
        bytes: "floor-one",
        mediaType: "image/png",
        operationKey: "openapi:available_seats:response-asset:0:seatMapAsset",
      },
      {
        bytes: "floor-two",
        mediaType: "image/png",
        operationKey:
          "openapi:available_seats:response-asset:1:secondFloorSeatMapAsset",
      },
    ]);
    assertEquals(result, {
      availableSeats: ["01", "02"],
      seatMapAsset: {
        assetId: "asset-1",
        kind: "image",
        role: "attachment",
        mediaType: "image/png",
        disposition: "attachment",
      },
      secondFloorSeatMapAsset: {
        assetId: "asset-2",
        kind: "image",
        role: "attachment",
        mediaType: "image/png",
        disposition: "attachment",
      },
    });
    assertEquals(JSON.stringify(result).includes("data:image"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAPI response assets validate every configured field before publication", async () => {
  const definition = api("available_seats", {
    responseAssets: {
      available_seats: [
        { dataUrlField: "seatMapImg", mediaTypes: ["image/png"] },
        { dataUrlField: "secondFloorSeatMapImg", mediaTypes: ["image/png"] },
      ],
    },
  });
  let publishes = 0;
  const context = actionContext({
    content: {
      publish() {
        publishes += 1;
        throw new Error("must not publish");
      },
    },
  } as unknown as Partial<ActionContext>);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(Response.json({
      seatMapImg: `data:image/png;base64,${btoa("floor-one")}`,
      secondFloorSeatMapImg: "not-a-data-url",
    }));
  try {
    await assertRejects(
      () =>
        action(
          createOpenApiToolsPlugin({ apis: [definition] }),
          "available_seats",
        ).execute({}, context) as Promise<unknown>,
      TypeError,
      "is not a valid data URL",
    );
    assertEquals(publishes, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAPI aliases are deterministic and collisions fail composition", () => {
  const normalized = createOpenApiToolsPlugin({
    apis: [api("GET /records")],
  });
  assertEquals(Object.keys(normalized.actions), ["api_GET_records"]);
  assertThrows(
    () =>
      createOpenApiToolsPlugin({
        apis: [
          api("same", { id: "one" }),
          api("same", { id: "two" }),
        ],
      }),
    TypeError,
    "alias collision 'same'",
  );
});

Deno.test("OpenAPI alias maps are declaration maps and retain every operation alias", () => {
  const definition = defineApi({
    id: "fixture-api",
    name: "Fixture API",
    baseUrl: "https://example.test",
    openApiSchema: {
      openapi: "3.1.0",
      paths: {
        "/one": {
          get: { operationId: "first_operation", responses: { 200: {} } },
        },
        "/two": {
          post: { operationId: "second_operation", responses: { 200: {} } },
        },
      },
    },
  });
  const arrayPlugin = createOpenApiToolsPlugin({ apis: [definition] });
  const mapPlugin = createOpenApiToolsPlugin({
    apis: { fixture: definition },
  });
  assertEquals(Object.keys(mapPlugin.actions), [
    "first_operation",
    "second_operation",
  ]);
  assertEquals(Object.keys(mapPlugin.resources.tools), [
    "first_operation",
    "second_operation",
  ]);
  assertEquals(
    Object.keys(mapPlugin.actions),
    Object.keys(arrayPlugin.actions),
  );
});

Deno.test("defineApi snapshots mutable JSON and OpenAPI maps reject unsafe declarations", () => {
  const schema = {
    openapi: "3.1.0",
    paths: {
      "/status": {
        get: { operationId: "original_status", responses: { 200: {} } },
      },
    },
  };
  const api = defineApi({
    id: "snapshot-api",
    name: "Snapshot API",
    baseUrl: "https://example.test",
    openApiSchema: schema,
    headers: { "X-Original": "yes" },
  });
  schema.paths["/status"].get.operationId = "mutated_status";
  const plugin = createOpenApiToolsPlugin({ apis: { fixture: api } });
  assertEquals(Object.keys(plugin.actions), ["original_status"]);

  assertThrows(
    () => createOpenApiToolsPlugin({ apis: { "not-valid": api } }),
    TypeError,
    "invalid alias",
  );
  const unsafe = Object.create(null) as Record<string, typeof api>;
  unsafe.__proto__ = api;
  assertThrows(
    () => createOpenApiToolsPlugin({ apis: unsafe }),
    TypeError,
    "invalid alias",
  );
  const customPrototype = Object.create({ inherited: api });
  customPrototype.fixture = api;
  assertThrows(
    () => createOpenApiToolsPlugin({ apis: customPrototype }),
    TypeError,
    "plain alias map",
  );
});

Deno.test("OpenAPI Action cancellation remains AbortError", async () => {
  const controller = new AbortController();
  const context = actionContext({ signal: controller.signal });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException("cancelled", "AbortError"));
        return;
      }
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("cancelled", "AbortError")), { once: true });
    });
  try {
    const execution = action(
      createOpenApiToolsPlugin({ apis: [api("cancel_request")] }),
      "cancel_request",
    ).execute({}, context);
    controller.abort();
    const error = await assertRejects(async () => await execution);
    assertEquals((error as Error).name, "AbortError");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAPI dynamic-auth caches are isolated per generated API instance", async () => {
  const dynamicApi = (authUrl: string): API =>
    api("authenticated", {
      id: "same-id",
      name: "Same Display Name",
      auth: {
        type: "dynamic",
        authEndpoint: { url: authUrl },
        tokenExtraction: { type: "bearer" },
        cache: { enabled: true, duration: 3_600 },
      },
    });
  const first = createOpenApiToolsPlugin({
    apis: [dynamicApi("https://auth-a.test/token")],
  });
  const second = createOpenApiToolsPlugin({
    apis: [dynamicApi("https://auth-b.test/token")],
  });
  const authCalls: string[] = [];
  const apiAuthorizations: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url.startsWith("https://auth-")) {
      authCalls.push(url);
      return Promise.resolve(new Response(url.includes("auth-a") ? "a" : "b"));
    }
    apiAuthorizations.push(
      new Headers(init?.headers).get("authorization") ?? "",
    );
    return Promise.resolve(Response.json({ ok: true }));
  };
  try {
    await action(first, "authenticated").execute({}, actionContext());
    await action(second, "authenticated").execute({}, actionContext());
    assertEquals(authCalls, [
      "https://auth-a.test/token",
      "https://auth-b.test/token",
    ]);
    assertEquals(apiAuthorizations, ["Bearer a", "Bearer b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAPI dynamic authentication honors Action cancellation", async () => {
  const definition = api("auth_cancel", {
    auth: {
      type: "dynamic",
      authEndpoint: { url: "https://auth-cancel.test/token" },
      tokenExtraction: { type: "bearer" },
    },
  });
  const controller = new AbortController();
  const cancellation = new Error("tenant cancelled authentication");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(init.signal.reason);
        return;
      }
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
    });
  try {
    const execution = action(
      createOpenApiToolsPlugin({ apis: [definition] }),
      "auth_cancel",
    ).execute({}, actionContext({ signal: controller.signal }));
    controller.abort(cancellation);
    const error = await assertRejects(async () => await execution);
    assertEquals((error as Error).name, "AbortError");
    assertEquals((error as Error).message, cancellation.message);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
