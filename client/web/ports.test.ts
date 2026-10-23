import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { CopilotzHttpError, createCopilotzClient } from "../index.ts";
import {
  ActionFailure,
  createBrowserPorts,
  ownerSequence,
  readFailure,
} from "./ports.ts";
import { createBrowserRuntime } from "./runtime.ts";
import {
  MemorySubscriptions,
  record,
  tick,
} from "../testing/live-transport.test.ts";

Deno.test("SDK browser ports preserve exact seq, share device reads and settle only applied progress", async () => {
  const live = new MemorySubscriptions();
  const base = createCopilotzClient({ baseUrl: "/api", device: live });
  const calls: unknown[] = [];
  const seq = "9007199254740995";
  const client = {
    ...base,
    actions: {
      ...base.actions,
      submit: (...args: Parameters<typeof base.actions.submit>) => {
        calls.push(args);
        return Promise.resolve({
          operationId: "op",
          correlationId: "c",
          status: "pending",
          acceptedAt: "now",
        });
      },
    },
    operations: {
      ...base.operations,
      observe: (
        options: Parameters<typeof base.operations.observe>[0],
      ) => {
        calls.push(options.operationIds);
        return Promise.resolve("terminal");
      },
      result: () => Promise.resolve({ value: "done", seq }),
      cancel: (id: string) => {
        calls.push(id);
        return Promise.resolve();
      },
    },
  };
  const ports = createBrowserPorts(client);
  assertEquals(ports.live, client.subscriptions);
  const request = { collection: "entry", id: "a" };
  await live.publish(request, {
    t: "snapshot",
    sequence: "9007199254740993",
    checkpoint: "before",
    complete: true,
    rows: [record({ id: "a", value: 1 })],
  });
  const runtime = await createBrowserRuntime({
    ...ports,
    plugins: [{
      id: "app",
      collections: {
        entry: {
          placement: "server",
          commands: {
            set: { mutate: ({ input }) => ({ set: { value: input } }) },
          },
        },
      },
      actions: {
        set: {
          id: "entry.set",
          placement: "server",
          optimistic: {
            collection: "entry",
            command: "set",
            id: () => "a",
          },
        },
      },
    }],
  });
  try {
    const observed = runtime.observe((ctx) => ctx.collections.entry.get("a"));
    await tick();
    assertEquals(await runtime.actions.set(2).result(), "done");
    assertEquals(observed.getSnapshot().pending, true);
    await live.publish(request, {
      t: "batch",
      from: "9007199254740993",
      to: "9007199254740994",
      checkpoint: "middle",
      changes: [],
    });
    assertEquals(observed.getSnapshot().pending, true);
    await live.publish(request, {
      t: "batch",
      from: "9007199254740994",
      to: seq,
      checkpoint: "after",
      changes: [{ seq, id: "a", record: record({ id: "a", value: 2 }) }],
    });
    assertEquals(observed.getSnapshot().pending, false);
    assertEquals(observed.getSnapshot().value?.value, 2);
    assertEquals(calls.length, 1);
    await ports.actions.cancel("op");
    assertEquals(calls.at(-1), "op");
  } finally {
    runtime.dispose();
  }
  assertEquals(ownerSequence(seq), 9007199254740995n);
  for (
    const bad of [undefined, -1, Number.MAX_SAFE_INTEGER + 1, "1.0", "-1", "01"]
  ) assertThrows(() => ownerSequence(bad), ActionFailure);
});

Deno.test("browser Action transport rejects returned failures like thrown refusals and never invents seq", async () => {
  const base = createCopilotzClient({ baseUrl: "/api" });
  const refused = { code: "forbidden", message: "Not allowed", status: 403 };
  let outcome: unknown = { ok: false, error: refused };
  let seq: string = "1";
  let thrown: unknown;
  const client = {
    ...base,
    actions: {
      ...base.actions,
      submit: () => {
        if (thrown) throw thrown;
        return Promise.resolve({
          operationId: "op",
          correlationId: "c",
          status: "pending",
          acceptedAt: "now",
        });
      },
    },
    operations: {
      ...base.operations,
      observe: () => Promise.resolve(undefined),
      result: () => Promise.resolve({ value: outcome, seq }),
    },
  };
  const ports = createBrowserPorts(client);
  const invoke = () =>
    ports.actions.invoke("entry.set", {}, {
      idempotencyKey: "key",
      signal: new AbortController().signal,
      accepted() {},
    });
  const returned = await assertRejects(invoke, ActionFailure, "Not allowed");
  thrown = new CopilotzHttpError(403, "forbidden", "Not allowed");
  const error = await assertRejects(invoke, CopilotzHttpError);
  assertEquals(readFailure(returned), readFailure(error));
  thrown = undefined;
  outcome = { ok: true, error: "advisory" };
  assertEquals((await invoke()).seq, 1n);
  seq = undefined as unknown as string;
  await assertRejects(invoke, ActionFailure, "owner sequence");
});

Deno.test("query error detail distinguishes network TypeErrors from invalid protocol and domain results", () => {
  assertEquals(
    readFailure(new TypeError("Failed to fetch")).kind,
    "unavailable",
  );
  assertEquals(
    readFailure(new ActionFailure("invalid_input", "Bad selection", 422)).kind,
    "invalid",
  );
  assertEquals(
    readFailure(new ActionFailure("service_busy", "Busy", 503)).kind,
    "unavailable",
  );
});

Deno.test("returned and thrown rate-limit refusals have the same retryable query detail", () => {
  assertEquals(
    readFailure(new ActionFailure("rate_limit", "Busy", 429)),
    readFailure(new CopilotzHttpError(429, "rate_limit", "Busy")),
  );
  assertEquals(
    readFailure(new ActionFailure("rate_limit", "Busy", 429)).kind,
    "unavailable",
  );
});
