import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createContentResolver,
  createMemoryAssetRepository,
} from "../content/index.ts";
import { defineAction } from "./define.ts";
import { createActionCallers } from "./invoker.ts";
import type {
  ActionContext,
  ActionEventData,
  ActionLifecycleInput,
  RuntimeContent,
} from "./types.ts";
import {
  actionContentDeclaration,
  prepareActionContentInput,
} from "./content.ts";

type Input = { messages: { content: Record<string, unknown>[] }[] };

function fixture() {
  const assets = createMemoryAssetRepository();
  let reads = 0;
  let publishes = 0;
  const resolver = createContentResolver({ assets });
  const content = {
    authorize: (ref: Parameters<RuntimeContent["resolve"]>[0]) =>
      resolver.authorize(ref, { namespace: "tenant" }),
    getMany: (ids: readonly string[]) => assets.getMany("tenant", ids),
    publish: (
      input: Parameters<RuntimeContent["publish"]>[0],
      options: { operationKey: string },
    ) => {
      publishes++;
      return assets.publish({
        ...input,
        namespace: "tenant",
        idempotencyKey: options.operationKey,
      });
    },
    resolveMany: (refs: Parameters<RuntimeContent["resolveMany"]>[0]) => {
      reads++;
      return resolver.getMany(refs, { namespace: "tenant" });
    },
  } as RuntimeContent;
  const events: ActionLifecycleInput[] = [];
  const callers = (
    execute: (input: Input, context: ActionContext) => unknown,
    key = "run",
  ) =>
    createActionCallers({
      test: defineAction({
        id: "test.content",
        content: { input: ["messages[].content"] },
        execute,
      }),
    }, {
      signal: new AbortController().signal,
      content,
      createInvocationKey: () => key,
      actionLifecycle: {
        emit: (data) => {
          events.push(structuredClone(data));
          return Promise.resolve(undefined as never);
        },
        invoked: (id) =>
          Promise.resolve(
            events.find((e) =>
              e.actionRunId === id && e.status === "invoked"
            ) as never ?? null,
          ),
        terminal: (id) =>
          Promise.resolve(
            events.find((e) =>
              e.actionRunId === id && e.status === "completed"
            ) as never ?? null,
          ),
      },
      createContext: (args) => ({ progress: args.progress }) as ActionContext,
    });
  return {
    assets,
    content,
    events,
    callers,
    get reads() {
      return reads;
    },
    get publishes() {
      return publishes;
    },
  };
}

Deno.test("Action content preserves bytes while lifecycle stores references and cached retries avoid body reads", async () => {
  const f = fixture();
  const value = new Uint8Array([1, 2, 255]);
  const asset = await f.assets.publish({
    namespace: "tenant",
    mediaType: "image/png",
    body: value,
  });
  const input = {
    messages: [{
      content: [{
        assetId: asset.id,
        kind: "image",
        role: "body",
        mediaType: "image/png",
        value,
      }],
    }],
  };
  let executions = 0;
  const actions = f.callers(async (prepared, ctx) => {
    executions++;
    assert(prepared.messages[0].content[0].value instanceof Uint8Array);
    assertEquals(prepared.messages[0].content[0].value, value);
    prepared.messages[0].content[0].value[0] = 99;
    await ctx.progress({ status: "working" });
    return "done";
  });
  assertEquals(await actions.test(input), "done");
  assertEquals(await actions.test(input), "done");
  assertEquals(executions, 1);
  assertEquals(f.reads, 0);
  assertEquals(f.publishes, 0);
  assertEquals(value[0], 1);
  assertEquals(f.events.map((e) => e.status), [
    "invoked",
    "progress",
    "completed",
  ]);
  for (const event of f.events) {
    assertEquals(
      "value" in (event.input as Input).messages[0].content[0],
      false,
    );
  }
  const invoked = f.events[0] as ActionEventData;
  f.events.splice(1);
  const recovered = f.callers((prepared) => {
    assertEquals(prepared.messages[0].content[0].value, value);
    return "resumed";
  });
  assertEquals(await recovered.test(invoked.input as Input), "resumed");
  assertEquals(f.reads, 1);
});

Deno.test("prepared Action replays captured content references without evaluating a newer factory", async () => {
  const f = fixture();
  const input: Input = {
    messages: [{
      content: [{
        kind: "text",
        role: "body",
        mediaType: "text/plain",
        value: "captured bytes",
      }],
    }],
  };
  const first = f.callers(() => "first", "prepared-content");
  assertEquals(
    await first.test.prepare(
      () => ({ input, metadata: { revision: 1 } }),
      { operationKey: "latest" },
    ),
    "first",
  );
  // Simulate recovery after the invoked receipt was committed but before its
  // terminal result became durable.
  f.events.splice(1);
  let factoryCalls = 0;
  const recovered = f.callers((value) => {
    assertEquals(value.messages[0].content[0].value, "captured bytes");
    return "recovered";
  }, "prepared-content");
  assertEquals(
    await recovered.test.prepare(() => {
      factoryCalls += 1;
      return { input: { messages: [] } };
    }, { operationKey: "latest" }),
    "recovered",
  );
  assertEquals(factoryCalls, 0);
  assertEquals(f.reads, 1);
});

Deno.test("Action content deduplicates literal bodies, preserves per-entry kinds, and does not load descriptors", async () => {
  const f = fixture();
  const descriptor = await f.assets.publish({
    namespace: "tenant",
    mediaType: "application/pdf",
    body: new Uint8Array([5]),
  });
  const base = {
    kind: "text",
    role: "body",
    mediaType: "text/plain",
    value: "Hello",
  };
  const callers = f.callers((prepared) => {
    assertEquals(prepared.messages[0].content[0].value, "Hello");
    assertEquals(
      prepared.messages[0].content[0].assetId,
      prepared.messages[0].content[1].assetId,
    );
    assertEquals("value" in prepared.messages[0].content[2], false);
    return null;
  }, "literal");
  await callers.test({
    messages: [{
      content: [base, { ...base, role: "reasoning" }, {
        assetId: descriptor.id,
        kind: "file",
        role: "attachment",
        mediaType: descriptor.mediaType,
        resolve: false,
      }],
    }],
  });
  assertEquals(f.publishes, 1);
  assertEquals(f.reads, 0);
  assertEquals(
    (f.events[0].input as Input).messages[0].content[2].resolve,
    false,
  );
});

Deno.test("Action content rejects changed and cross-namespace Assets before invocation", async () => {
  const f = fixture();
  const asset = await f.assets.publish({
    namespace: "tenant",
    mediaType: "text/plain",
    body: new TextEncoder().encode("original"),
  });
  const actions = f.callers(() => {
    throw new Error("must not execute");
  });
  await assertRejects(
    () =>
      actions.test({
        messages: [{
          content: [{
            assetId: asset.id,
            kind: "text",
            role: "body",
            mediaType: "text/plain",
            value: "changed",
          }],
        }],
      }),
    Error,
    "does not match",
  );
  const other = await f.assets.publish({
    namespace: "other",
    mediaType: "text/plain",
    body: new TextEncoder().encode("original"),
  });
  await assertRejects(
    () =>
      actions.test({
        messages: [{
          content: [{
            assetId: other.id,
            kind: "text",
            role: "body",
            mediaType: "text/plain",
            value: "original",
          }],
        }],
      }),
    Error,
    "not found",
  );
  assertEquals(f.events, []);
});

Deno.test("Action content declaration rejects unsafe paths and freezes caller configuration", () => {
  for (
    const path of [
      "__proto__.content",
      "messages..content",
      "messages[0].content",
      "messages[].constructor",
    ]
  ) {
    assertThrows(() => actionContentDeclaration({ input: [path] }), TypeError);
  }
  const paths = ["messages[].content"];
  const action = defineAction({
    id: "test",
    content: { input: paths },
    execute: () => null,
  });
  paths.push("other");
  assertEquals(action.content?.input, ["messages[].content"]);
});

Deno.test("Action content accepts resolved JSON without rewriting its original representation", async () => {
  const f = fixture();
  const asset = await f.assets.publish({
    namespace: "tenant",
    mediaType: "application/json",
    body: new TextEncoder().encode('{ "b": 2, "a": 1 }'),
  });
  const value = { a: 1, b: 2 };
  const input = {
    messages: [{
      content: [{
        assetId: asset.id,
        kind: "json",
        role: "body",
        mediaType: asset.mediaType,
        value,
      }],
    }],
  };
  await f.callers((prepared) => {
    assertEquals(prepared.messages[0].content[0].value, value);
    return null;
  }).test(input);
  assertEquals(f.publishes, 0);
  assertEquals(f.reads, 1);
});

Deno.test("Action content enforces budgets, cancellation and authorization before invocation", async () => {
  const f = fixture();
  const input = {
    messages: [{
      content: [{
        kind: "text",
        role: "body",
        mediaType: "text/plain",
        value: "hello",
      }],
    }],
  };
  const declaration = actionContentDeclaration({
    input: ["messages[].content"],
    byteLimit: 4,
  });
  await assertRejects(
    () =>
      prepareActionContentInput(
        input,
        declaration,
        f.content,
        new AbortController().signal,
      ),
    RangeError,
    "byte limit",
  );
  assertEquals(f.publishes, 0);
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () =>
      prepareActionContentInput(
        input,
        declaration,
        f.content,
        controller.signal,
      ),
    DOMException,
  );
  const asset = await f.assets.publish({
    namespace: "tenant",
    mediaType: "text/plain",
    body: new TextEncoder().encode("hello"),
  });
  const denied = {
    ...f.content,
    authorize: () => Promise.reject(new Error("Denied")),
  };
  await assertRejects(
    () =>
      prepareActionContentInput(
        {
          messages: [{
            content: [{ ...input.messages[0].content[0], assetId: asset.id }],
          }],
        },
        actionContentDeclaration({ input: ["messages[].content"] }),
        denied,
        new AbortController().signal,
      ),
    Error,
    "Denied",
  );
  assertEquals(f.reads, 0);
});

Deno.test("Action content schemas validate prepared values before recording invocation", async () => {
  const f = fixture();
  const action = defineAction({
    id: "test.schema-content",
    content: { input: ["content"] },
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "array",
          items: {
            type: "object",
            properties: { value: { type: "string", minLength: 3 } },
            required: ["value"],
          },
        },
      },
    },
    execute: () => "ok",
  });
  let emitted = 0;
  const callers = createActionCallers({ action }, {
    signal: new AbortController().signal,
    content: f.content,
    actionLifecycle: {
      emit: () => {
        emitted++;
        return Promise.resolve(undefined as never);
      },
      invoked: () => Promise.resolve(null),
      terminal: () => Promise.resolve(null),
    },
    createContext: () => ({}) as ActionContext,
  });
  await assertRejects(
    () =>
      callers.action({
        content: [{
          kind: "text",
          role: "body",
          mediaType: "text/plain",
          value: "x",
        }],
      }),
    TypeError,
  );
  assertEquals(emitted, 0);
  assertEquals(
    await callers.action({
      content: [{
        kind: "text",
        role: "body",
        mediaType: "text/plain",
        value: "valid",
      }],
    }),
    "ok",
  );
  assertEquals(emitted, 2);
});

Deno.test("Action hydration rejects invalid UTF-8 even when a host returns undecoded bytes", async () => {
  const f = fixture();
  const bytes = new Uint8Array([0xc3, 0x28]);
  const asset = await f.assets.publish({
    namespace: "tenant",
    mediaType: "text/plain",
    body: bytes,
  });
  const ref = {
    assetId: asset.id,
    kind: "text" as const,
    role: "body",
    mediaType: asset.mediaType,
  };
  const prepared = await prepareActionContentInput(
    { messages: [{ content: [ref] }] },
    actionContentDeclaration({ input: ["messages[].content"] }),
    {
      ...f.content,
      resolveMany: () => Promise.resolve([{ ref, asset, bytes }]),
    },
    new AbortController().signal,
  );
  const error = await assertRejects(() => prepared.hydrate());
  assertEquals((error as { code: string }).code, "asset_corrupted");
  assertEquals((error as { assetId: string }).assetId, asset.id);
  assertEquals((error as { namespace: string }).namespace, "tenant");
});
