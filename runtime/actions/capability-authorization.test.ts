import { assertEquals, assertThrows } from "@std/assert";
import { authorizeActionCapabilities } from "./capability-authorization.ts";
import { actionCallerDefinitionId } from "./invoker.ts";
import { recordActionCaller } from "./caller-identity.ts";
import type { ActionContext } from "./types.ts";
import { captureOwnerCommandAuthorization } from "../engine/command-authorization.ts";
Deno.test("authorized Action capabilities preserve caller identity, named methods, stream APIs and revocation", async () => {
  let active = true;
  const child = Object.assign((value: string) => value, {
    prepareNamed: (value: string) => `named:${value}`,
    prepare: (factory: () => string) => factory(),
  });
  recordActionCaller(child, "fixture.child");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  const content = {
    value: "bound",
    get() {
      assertEquals(this, content);
      assertEquals(typeof captureOwnerCommandAuthorization(), "function");
      return this.value;
    },
    open: () => body,
  };
  const context = authorizeActionCapabilities(
    { actions: { child }, content } as unknown as ActionContext,
    () => {},
    () => {
      if (!active) throw new Error("revoked");
    },
  );
  assertEquals(
    actionCallerDefinitionId(context.actions.child),
    "fixture.child",
  );
  assertEquals(await context.actions.child("value"), "value");
  assertEquals(
    await context.actions.child.prepareNamed("request" as never, {} as never),
    "named:request",
  );
  assertEquals(
    await context.actions.child.prepare(() => "factory" as never, {} as never),
    "factory",
  );
  assertEquals<unknown>(await context.content.get("id"), "bound");
  const stream = await context.content.open({} as never);
  const reader = stream.getReader();
  assertEquals(reader instanceof Promise, false);
  assertEquals((await reader.read()).value, new Uint8Array([1]));
  reader.releaseLock();
  active = false;
  assertThrows(() => context.actions.child("late"), Error, "revoked");
  assertThrows(() => stream.getReader(), Error, "revoked");
});
Deno.test("frozen capability facades preserve synchronous stream branches and revoke every retained reader", async () => {
  let active = true;
  const stream = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([2]));
        c.close();
      },
    });
  const child = Object.freeze(
    Object.assign(() => "ok", { prepareNamed: () => "named" }),
  );
  recordActionCaller(child, "fixture.frozen");
  const ctx = authorizeActionCapabilities(
    Object.freeze({
      actions: Object.freeze({ child }),
      collections: Object.freeze({
        records: Object.freeze({ get: () => "row" }),
      }),
      content: Object.freeze({ open: stream }),
    }) as unknown as ActionContext,
    () => {},
    () => {
      if (!active) throw new Error("revoked");
    },
  );
  assertEquals(actionCallerDefinitionId(ctx.actions.child), "fixture.frozen");
  assertEquals(await ctx.actions.child({}), "ok");
  assertEquals<unknown>(
    await ctx.collections.records.get({ id: "one" }),
    "row",
  );
  const original = await ctx.content.open({} as never);
  const branches = original.tee();
  assertEquals(branches instanceof Promise, false);
  const reader = branches[0].getReader();
  const piped = branches[1].pipeThrough(new TransformStream());
  assertEquals(piped instanceof Promise, false);
  const pipedReader = piped.getReader();
  assertEquals((await reader.read()).value, new Uint8Array([2]));
  assertEquals((await pipedReader.read()).value, new Uint8Array([2]));
  active = false;
  assertThrows(() => reader.read(), Error, "revoked");
  assertThrows(() => pipedReader.read(), Error, "revoked");
  assertThrows(() => branches[0].getReader(), Error, "revoked");
});

import { assertRejects } from "@std/assert";
Deno.test("native acquired streams reauthorize bytes after policy revocation while their Action stays live", async () => {
  for (
    const mode of [
      "reader",
      "tee",
      "pipeThrough",
      "iterator",
      "pipeTo",
      "responseText",
      "responseBytes",
    ] as const
  ) {
    let allowed = true, checks = 0, reads = 0;
    const context = authorizeActionCapabilities(
      {
        content: {
          open: () =>
            new ReadableStream<Uint8Array>({
              pull(controller) {
                reads++;
                controller.enqueue(new Uint8Array([65 + reads]));
                if (reads === 3) controller.close();
              },
            }, { highWaterMark: 0 }),
        },
      } as unknown as ActionContext,
      () => {},
      () => {},
      undefined,
      () => {
        checks++;
        return allowed
          ? Promise.resolve()
          : Promise.reject(new Error("current policy denied"));
      },
    );
    const stream = await context.content.open({} as never);
    assertEquals(stream instanceof ReadableStream, true);
    if (mode === "responseText" || mode === "responseBytes") {
      allowed = false;
      const response = new Response(stream);
      await assertRejects(
        () =>
          mode === "responseText" ? response.text() : response.arrayBuffer(),
        Error,
        "current policy denied",
      );
      assertEquals(reads, 0);
    } else if (mode === "pipeTo") {
      const writes: unknown[] = [];
      await assertRejects(
        () =>
          stream.pipeTo(
            new WritableStream({
              write(chunk) {
                writes.push(chunk);
                allowed = false;
              },
            }),
          ),
        Error,
        "current policy denied",
      );
      assertEquals(writes.length, 1);
    } else if (mode === "iterator") {
      const iterator = stream[Symbol.asyncIterator]();
      assertEquals((await iterator.next()).value, new Uint8Array([66]));
      allowed = false;
      await assertRejects(
        () => iterator.next(),
        Error,
        "current policy denied",
      );
    } else {
      const branches = mode === "tee" ? stream.tee() : [stream];
      const selected = mode === "pipeThrough"
        ? stream.pipeThrough(new TransformStream())
        : branches[0];
      const reader = selected.getReader();
      assertEquals((await reader.read()).value, new Uint8Array([66]));
      const retained = mode === "tee" ? branches[1].getReader() : reader;
      allowed = false;
      await assertRejects(
        () => retained.read(),
        Error,
        "current policy denied",
      );
    }
    assertEquals(checks > 0, true);
  }
});
Deno.test("native acquired stream works with Response and async iteration while authorized", async () => {
  const ctx = authorizeActionCapabilities(
    {
      content: {
        open: () =>
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode("safe"));
              c.close();
            },
          }),
      },
    } as unknown as ActionContext,
    () => {},
    () => {},
    undefined,
    () => Promise.resolve(),
  );
  assertEquals(
    await new Response(await ctx.content.open({} as never)).text(),
    "safe",
  );
  assertEquals(
    new TextDecoder().decode(
      await new Response(await ctx.content.open({} as never)).arrayBuffer(),
    ),
    "safe",
  );
  const output: Uint8Array[] = [];
  for await (const chunk of await ctx.content.open({} as never)) {
    output.push(chunk);
  }
  assertEquals(new TextDecoder().decode(output[0]), "safe");
});

Deno.test("non-command acquired read capabilities reauthorize before disclosure and never claim committed mutation rollback", async () => {
  let allowed = true, mutated = 0;
  const ctx = authorizeActionCapabilities(
    {
      content: {
        get: () => "private",
        materialize: () => {
          mutated++;
          allowed = false;
          return "committed";
        },
      },
    } as unknown as ActionContext,
    () => {},
    () => {},
    undefined,
    () =>
      allowed
        ? Promise.resolve()
        : Promise.reject(new Error("disclosure denied")),
  );
  assertEquals<unknown>(await ctx.content.get("id"), "private");
  allowed = false;
  await assertRejects(() => ctx.content.get("id"), Error, "disclosure denied");
  allowed = true;
  await assertRejects(
    () => ctx.content.materialize({} as never),
    Error,
    "disclosure denied",
  );
  assertEquals(mutated, 1);
});

Deno.test("revoked native readers can cancel and release owned resources while writer mutation remains fenced", async () => {
  let active = true, cancelled = 0, writes = 0;
  const writer = new WritableStream({
    close() {
      writes++;
    },
    abort() {
      writes++;
    },
  }).getWriter();
  const ctx = authorizeActionCapabilities(
    {
      content: {
        open: () =>
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }, { highWaterMark: 0 }),
        writer,
      },
    } as unknown as ActionContext,
    () => {},
    () => {
      if (!active) throw new Error("revoked");
    },
    undefined,
    () => Promise.resolve(),
  );
  const stream = await ctx.content.open({} as never);
  const reader = stream.getReader();
  const guardedWriter =
    (ctx.content as unknown as { writer: WritableStreamDefaultWriter }).writer;
  active = false;
  await reader.cancel();
  reader.releaseLock();
  assertEquals(cancelled, 1);
  assertThrows(() => guardedWriter.close(), Error, "revoked");
  assertThrows(() => guardedWriter.abort(), Error, "revoked");
  assertEquals(writes, 0);
  writer.releaseLock();
});
Deno.test("post-acquisition denial disposes the new read resource without waiting for noncooperative cancellation", async () => {
  let allowed = true, cancelled = 0, settled = false;
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ctx = authorizeActionCapabilities(
    {
      content: {
        open: () => {
          allowed = false;
          return new ReadableStream({
            cancel() {
              cancelled++;
              return cleanup.then(() => {
                settled = true;
              });
            },
          }, { highWaterMark: 0 });
        },
      },
    } as unknown as ActionContext,
    () => {},
    () => {},
    undefined,
    () => allowed ? Promise.resolve() : Promise.reject(new Error("denied")),
  );
  await assertRejects(() => ctx.content.open({} as never), Error, "denied");
  assertEquals(cancelled, 1);
  assertEquals(settled, false);
  finish();
  await cleanup;
  await Promise.resolve();
  assertEquals(settled, true);
});
Deno.test("denied acquisition never cancels a native resource owned by a different invocation", async () => {
  let cancelled = 0, allowed = true;
  const shared = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([7]));
    },
    cancel() {
      cancelled++;
    },
  }, { highWaterMark: 0 });
  const first = authorizeActionCapabilities(
    { content: { open: () => shared } } as unknown as ActionContext,
    () => {},
    () => {},
    undefined,
    () => Promise.resolve(),
  );
  const original = await first.content.open({} as never);
  const second = authorizeActionCapabilities(
    {
      content: {
        open: () => {
          allowed = false;
          return original;
        },
      },
    } as unknown as ActionContext,
    () => {},
    () => {},
    undefined,
    () => allowed ? Promise.resolve() : Promise.reject(new Error("denied")),
  );
  await assertRejects(() => second.content.open({} as never), Error, "denied");
  assertEquals(cancelled, 0);
  const reader = original.getReader();
  assertEquals((await reader.read()).value, new Uint8Array([7]));
  await reader.cancel();
  reader.releaseLock();
  assertEquals(cancelled, 1);
});
Deno.test("authorized writer preserves synchronous offset while mutations retain guards and lifetime", async () => {
  let active = true, offset = 0, mutations = 0;
  const writer = Object.freeze({
    id: "writer",
    offset: () => offset,
    append() {
      assertEquals(typeof captureOwnerCommandAuthorization(), "function");
      mutations++;
      return Promise.resolve({ endOffset: ++offset });
    },
    async close() {},
    async abort() {},
  });
  const ctx = authorizeActionCapabilities(
    { streams: { open: () => writer } } as unknown as ActionContext,
    () => {},
    () => {
      if (!active) throw new Error("revoked");
    },
  );
  const wrapped = await ctx.streams.open({} as never);
  assertEquals(wrapped.offset(), 0);
  assertEquals(typeof wrapped.offset(), "number");
  await wrapped.append({} as never);
  assertEquals(wrapped.offset(), 1);
  assertEquals(mutations, 1);
  active = false;
  assertThrows(() => wrapped.offset(), Error, "revoked");
  assertThrows(() => wrapped.append({} as never), Error, "revoked");
});
