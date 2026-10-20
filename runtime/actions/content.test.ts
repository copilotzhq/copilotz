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
    services = content,
  ) =>
    createActionCallers({
      test: defineAction({
        id: "test.content",
        content: { input: ["messages[].content"] },
        execute,
      }),
    }, {
      signal: new AbortController().signal,
      content: services,
      createInvocationKey: () => key,
      actionLifecycle: {
        // A receipt identity is written once, as in the event store.
        emit: (data) => {
          if (events.some((e) => e.deduplicationId === data.deduplicationId)) {
            return Promise.resolve({ deduplicated: true } as never);
          }
          events.push(structuredClone(data));
          return Promise.resolve({ deduplicated: false } as never);
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

Deno.test("prepared Action replays captured inline content without evaluating a newer factory", async () => {
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
  assertEquals(f.reads, 0);
  assertEquals(f.publishes, 0);
});

Deno.test("Action content keeps literal bodies inline, preserves per-entry kinds, and does not load descriptors", async () => {
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
  assertEquals(f.publishes, 0);
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
    "content is missing",
  );
  const reference = {
    assetId: asset.id,
    kind: "text",
    role: "body",
    mediaType: asset.mediaType,
  };
  const unavailable = f.callers(
    () => {
      throw new Error("must not execute");
    },
    "staging",
    {
      ...f.content,
      getMany: () => Promise.resolve([{ ...asset, state: "staging" }]),
    },
  );
  await assertRejects(
    () => unavailable.test({ messages: [{ content: [reference] }] }),
    Error,
    "not ready",
  );
  // Every descriptor is checked, even when two entries share one Asset.
  await assertRejects(
    () =>
      actions.test({
        messages: [{
          content: [reference, { ...reference, mediaType: "image/png" }],
        }],
      }),
    Error,
    "different media type",
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
  let executions = 0;
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
    execute: () => {
      executions++;
      return "ok";
    },
  });
  const events: ActionLifecycleInput[] = [];
  const callers = createActionCallers({ action }, {
    signal: new AbortController().signal,
    content: f.content,
    createInvocationKey: () => "schema-content",
    actionLifecycle: {
      emit: (data) => {
        const deduplicated = events.some((event) =>
          event.deduplicationId === data.deduplicationId
        );
        if (!deduplicated) events.push(structuredClone(data));
        return Promise.resolve({ deduplicated } as never);
      },
      invoked: (id) =>
        Promise.resolve(
          events.find((event) =>
            event.actionRunId === id && event.status === "invoked"
          ) as import("./types.ts").ActionInvokedData | undefined ?? null,
        ),
      terminal: (id) =>
        Promise.resolve(
          events.find((event) =>
            event.actionRunId === id && event.status === "completed"
          ) as import("./types.ts").ActionCompletedData | undefined ?? null,
        ),
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
  assertEquals(events, []);
  assertEquals(executions, 0);
  const valid = {
    content: [{
      kind: "text",
      role: "body",
      mediaType: "text/plain",
      value: "valid",
    }],
  };
  assertEquals(await callers.action(valid), "ok");
  assertEquals(events.map((event) => event.status), ["invoked", "completed"]);
  const capture = events[0];
  assert(capture.status === "invoked");
  assertEquals(capture.effectProtocol, 1);
  assertEquals(capture.input, valid);
  assertEquals(await callers.action(structuredClone(valid)), "ok");
  assertEquals(events.length, 2);
  assertEquals(executions, 1);
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

Deno.test("Action content accepts plain strings as text at declared paths", async () => {
  const f = fixture();
  const seen: Record<string, unknown>[][] = [];
  const actions = f.callers((prepared) => {
    seen.push(prepared.messages.map((message) => ({
      content: message.content.map(({ assetId: _, ...entry }) => entry),
    })));
    return "ok";
  });
  const text = (value: string) => ({
    kind: "text",
    role: "body",
    mediaType: "text/plain; charset=utf-8",
    value,
  });
  const strings = {
    messages: [
      { content: "You are terse." },
      { content: ["Hello ", text("there"), "!"] },
    ],
  };
  assertEquals(await actions.test(strings as never), "ok");
  // The handler sees ordinary text entries; the caller's input is untouched.
  assertEquals(seen, [[
    { content: [text("You are terse.")] },
    { content: [text("Hello "), text("there"), text("!")] },
  ]]);
  assertEquals(strings.messages[0].content, "You are terse.");

  // Lifecycle data preserves the exact text values inline.
  assertEquals(f.events.length > 0, true);
  const stored = f.events.flatMap((event) =>
    (event.input as Input).messages.flatMap((message) => message.content)
  );
  assertEquals(stored.length, 2 * 4);
  for (const entry of stored) {
    assertEquals(entry.assetId, undefined);
    assert(typeof entry.value === "string");
  }

  // Shorthand and explicit entries preserve the same inline value.
  const explicit = f.callers(() => "ok", "explicit");
  await explicit.test({ messages: [{ content: [text("You are terse.")] }] });
  const first = (f.events[0].input as Input).messages[0].content[0].value;
  const last = (f.events.at(-1)!.input as Input).messages[0].content[0].value;
  assertEquals(last, first);
});

Deno.test("Action content still rejects shapes that are neither text nor entries", async () => {
  const f = fixture();
  const actions = f.callers(() => "ok");
  const rejected = (content: unknown) =>
    assertRejects(
      () => actions.test({ messages: [{ content }] } as never),
      TypeError,
    );
  await rejected(42);
  await rejected({ kind: "text", role: "body", value: "x" });
  await rejected(null);
  await rejected([42]);
  await rejected([null]);
  await rejected([["nested"]]);
  await rejected([{ kind: "text", role: "body", mediaType: "text/plain" }]);
  // A string is an entry, not a whole document: the empty string is text.
  assertEquals(f.events.length, 0);
  assertEquals(
    await actions.test({ messages: [{ content: "" }] } as never),
    "ok",
  );
});

Deno.test("captured inline text, JSON and bytes replay exactly across JSON receipt storage", async () => {
  const f = fixture();
  const input: Input = {
    messages: [{
      content: [
        {
          kind: "text",
          role: "body",
          mediaType: "text/plain",
          value: "  exact\r\n\u0000é  ",
        },
        {
          kind: "json",
          role: "body",
          mediaType: "application/json",
          value: {
            nested: {
              assetId: "application-data",
              kind: "text",
              role: "body",
              mediaType: "text/plain",
              value: "keep this too",
            },
            items: [null, false, 0, ""],
          },
        },
        {
          kind: "image",
          role: "attachment",
          mediaType: "image/png",
          value: new Uint8Array([0, 255, 17]),
        },
      ],
    }],
  };
  const execute = (actual: Input) => {
    assertEquals(actual, input);
    return "ok";
  };
  await f.callers(execute).test.prepare(() => ({ input }), {
    operationKey: "exact",
  });
  const captured = JSON.parse(JSON.stringify(f.events[0]));
  f.events.splice(0, f.events.length, captured);
  let prepares = 0;
  await f.callers(execute).test.prepare(() => {
    prepares++;
    return { input: { messages: [] } };
  }, { operationKey: "exact" });
  assertEquals(prepares, 0);
  assertEquals(f.publishes, 0);
  assertEquals(f.reads, 0);
});

Deno.test("deleted captured content fails content_missing without re-preparing or executing", async () => {
  const f = fixture();
  const asset = await f.assets.publish({
    namespace: "tenant",
    mediaType: "text/plain",
    body: new TextEncoder().encode("original"),
  });
  const input: Input = {
    messages: [{
      content: [{
        assetId: asset.id,
        kind: "text",
        role: "body",
        mediaType: asset.mediaType,
      }],
    }],
  };
  await f.callers(() => "ok").test.prepare(() => ({ input }), {
    operationKey: "deleted",
  });
  f.events.splice(1);
  await f.assets.markDeleted("tenant", asset.id);
  let prepares = 0;
  let executions = 0;
  const error = await assertRejects(() =>
    f.callers(() => {
      executions++;
    }).test.prepare(() => {
      prepares++;
      return { input: { messages: [] } };
    }, { operationKey: "deleted" })
  );
  assertEquals((error as { code?: string }).code, "content_missing");
  assertEquals(prepares, 0);
  assertEquals(executions, 0);
  assertEquals(f.publishes, 0);
});

Deno.test("unavailable physical content maps to content_missing without hiding authorization errors", async () => {
  const f = fixture();
  const asset = await f.assets.publish({
    namespace: "tenant",
    mediaType: "text/plain",
    body: new TextEncoder().encode("original"),
  });
  const input = {
    content: [{
      assetId: asset.id,
      kind: "text",
      role: "body",
      mediaType: asset.mediaType,
    }],
  };
  const prepared = await prepareActionContentInput(input, {
    input: ["content"],
  }, {
    ...f.content,
    resolveMany: () =>
      Promise.reject(
        Object.assign(new Error("Body not found"), { code: "asset_not_found" }),
      ),
  }, new AbortController().signal);
  const error = await assertRejects(() => prepared.hydrate());
  assertEquals((error as { code?: string }).code, "content_missing");
});

Deno.test("recorded content Action results replay after input collection", async () => {
  const f = fixture();
  const asset = await f.assets.publish({
    namespace: "tenant",
    mediaType: "text/plain",
    body: new TextEncoder().encode("original"),
  });
  const input: Input = {
    messages: [{
      content: [{
        assetId: asset.id,
        kind: "text",
        role: "body",
        mediaType: asset.mediaType,
      }],
    }],
  };
  let executions = 0;
  const caller = f.callers(() => {
    executions++;
    return "recorded result";
  });
  await caller.test(input);
  await f.assets.markDeleted("tenant", asset.id);
  assertEquals(await caller.test(input), "recorded result");
  assertEquals(executions, 1);
  assertEquals(f.reads, 1);
});

Deno.test("a content preparation race returns the winning capture instead of comparing newer input", async () => {
  const f = fixture();
  const original: Input = {
    messages: [{
      content: [{
        kind: "text",
        role: "body",
        mediaType: "text/plain",
        value: "first capture",
      }],
    }],
  };
  let executions = 0;
  const winner = f.callers((input) => {
    executions++;
    assertEquals(input, original);
    return "winner";
  });
  const loser = f.callers(() => {
    throw new Error("must not execute newer input");
  });
  const output = await loser.test.prepare(async () => {
    await winner.test.prepare(
      () => ({ input: original, metadata: { revision: 1 } }),
      { operationKey: "race" },
    );
    return { input: { messages: [] }, metadata: { revision: 2 } };
  }, { operationKey: "race" });
  assertEquals(output, "winner");
  assertEquals(executions, 1);
  assertEquals(f.events.length, 2);
});
