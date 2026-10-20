import { assert, assertEquals, assertRejects } from "@std/assert";
import { createLiveQuery, type OperationResult } from "./live-query.ts";
import type { SubscriptionFrame } from "../runtime/subscriptions/types.ts";
const row = (id: string) => ({
  id,
  namespace: "main",
  createdAt: "",
  updatedAt: "",
});
const snapshot = (sequence = "1"): SubscriptionFrame => ({
  t: "snapshot",
  rows: [row("a")],
  sequence,
  checkpoint: `s${sequence}`,
  complete: true,
});
const batch = (from: string, to: string): SubscriptionFrame => ({
  t: "batch",
  from,
  to,
  changes: [],
  checkpoint: `b${to}`,
});
function transport() {
  const queue: SubscriptionFrame[] = [];
  let wake: (() => void) | undefined, ended = false;
  const cursors: (string | undefined)[] = [];
  return {
    cursors,
    push(frame: SubscriptionFrame) {
      queue.push(frame);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async observe(
      _name: string,
      _query: unknown,
      options: { checkpoint?: string },
    ) {
      await Promise.resolve();
      cursors.push(options.checkpoint);
      let detached = false;
      return {
        frames: {
          async *[Symbol.asyncIterator]() {
            while (!detached) {
              if (queue.length) yield queue.shift()!;
              else if (ended) return;
              else {await new Promise<void>((resolve) => {
                  wake = resolve;
                });}
            }
          },
        },
        detach() {
          detached = true;
          wake?.();
        },
      };
    },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
Deno.test("F6 §6.4 optimistic writes settle by applied seq, failure, empty progress and replacement snapshot", async () => {
  const t = transport();
  const live = createLiveQuery(t, "entry", {});
  try {
    const result = Promise.withResolvers<OperationResult>();
    live.optimistic("write", { title: "pending" }, result.promise);
    t.push(snapshot());
    await tick();
    result.resolve({ seq: "3", value: {} });
    await tick();
    assertEquals(live.optimisticLayers.size, 1);
    t.push(batch("1", "2"));
    await tick();
    assertEquals(live.optimisticLayers.size, 1);
    t.push(batch("2", "3"));
    await tick();
    assertEquals(live.optimisticLayers.size, 0);
    live.optimistic("failed", {}, Promise.reject(new Error("failed")));
    await tick();
    assertEquals(live.optimisticLayers.size, 0);
    live.optimistic("covered", {}, Promise.resolve({ seq: "8", value: null }));
    t.push({ t: "reset", reason: "scope" });
    t.push(snapshot("9"));
    await tick();
    assertEquals(live.optimisticLayers.size, 0);
    assertEquals(live.sequence, "9");
    assertEquals(t.cursors, [undefined, undefined]);
  } finally {
    live.close();
    await live.done;
  }
});
Deno.test("F6 §7 handler failure leaves rows and applied checkpoint unchanged and detaches", async () => {
  const t = transport();
  let calls = 0;
  const live = createLiveQuery(t, "entry", {}, {
    onChange() {
      if (++calls === 2) throw new Error("handler failed");
    },
  });
  t.push(snapshot());
  t.push(batch("1", "2"));
  await assertRejects(() => live.done, Error, "handler failed");
  assertEquals(live.checkpoint, "s1");
  assertEquals(live.sequence, "1");
  assertEquals(t.cursors.length, 1);
  live.close();
});
Deno.test("F6 client rejects gaps, reordered deltas and missing checkpoints", async () => {
  for (
    const invalid of [
      batch("2", "3"),
      { ...batch("1", "2"), checkpoint: "" },
      {
        ...batch("1", "2"),
        changes: [{ seq: "2", id: "b", record: row("b") }, {
          seq: "2",
          id: "a",
          record: row("a"),
        }],
      },
    ] as SubscriptionFrame[]
  ) {
    const t = transport();
    const live = createLiveQuery(t, "entry", {});
    t.push(snapshot());
    t.push(invalid);
    await assertRejects(() => live.done, TypeError);
    assertEquals(live.checkpoint, "s1");
    live.close();
  }
});
Deno.test("F6 reconnect resumes only the handle's applied checkpoint; clean EOF returns", async () => {
  const t = transport();
  const live = createLiveQuery(t, "entry", {});
  t.push(snapshot());
  t.end();
  await live.done;
  assertEquals(live.checkpoint, "s1");
  t.push(batch("1", "2"));
  await live.reconnect();
  assertEquals(t.cursors, [undefined, "s1"]);
  assertEquals(live.checkpoint, "b2");
  live.close();
});
Deno.test("F6 revoked stops without reconnect and queued snapshot cannot be mutated by handler", async () => {
  const t = transport();
  const live = createLiveQuery(t, "entry", {}, {
    onChange(rows) {
      (rows[0] as { id: string }).id = "changed";
    },
  });
  t.push(snapshot());
  await tick();
  assertEquals(live.rows[0].id, "a");
  t.push({ t: "revoked", reason: "permission" });
  await assertRejects(() => live.done, Error, "revoked");
  assertEquals(live.rows, []);
  assertEquals(live.status, "denied");
  assertEquals(t.cursors.length, 1);
  live.close();
});

Deno.test("F6 §7 transport failures back off and stop after three retries; forbidden stops immediately", async () => {
  let attempts = 0;
  const started = performance.now();
  const failing = createLiveQuery(
    {
      observe() {
        attempts++;
        return Promise.reject(new Error("disconnected"));
      },
    },
    "entry",
    {},
  );
  await assertRejects(() => failing.done, Error, "disconnected");
  assertEquals(attempts, 4);
  assert(performance.now() - started >= 650);
  failing.close();
  attempts = 0;
  const forbidden = createLiveQuery(
    {
      observe() {
        attempts++;
        return Promise.reject(
          Object.assign(new Error("denied"), { code: "forbidden" }),
        );
      },
    },
    "entry",
    {},
  );
  await assertRejects(() => forbidden.done, Error, "denied");
  assertEquals(attempts, 1);
  forbidden.close();
});
Deno.test("F6 §7 projection failure requires a replacement snapshot before reconnect", async () => {
  const t = transport();
  let fail = true;
  const live = createLiveQuery(t, "entry", {}, {
    onChange(_rows, frame) {
      if (fail && frame.t === "batch") throw new Error("projection");
    },
  });
  t.push(snapshot());
  t.push(batch("1", "2"));
  await assertRejects(() => live.done, Error, "projection");
  assertEquals(live.checkpoint, "s1");
  fail = false;
  t.push(snapshot("3"));
  t.end();
  await live.reconnect();
  assertEquals(t.cursors, [undefined, undefined]);
  assertEquals(live.checkpoint, "s3");
  live.close();
});

Deno.test("F6 deltas reconstruct a descending limited window without repeating unchanged membership", async () => {
  const t = transport();
  const query = {
    order: { field: "id", direction: "desc" as "desc" | "asc" },
    limit: 2,
  };
  const live = createLiveQuery(t, "entry", query);
  query.order.direction = "asc";
  t.push({
    t: "snapshot",
    rows: [row("b"), row("a")],
    sequence: "1",
    checkpoint: "first",
    complete: true,
  });
  t.push({
    t: "batch",
    from: "1",
    to: "2",
    checkpoint: "next",
    changes: [{ seq: "2", id: "a", record: null }, {
      seq: "2",
      id: "c",
      record: row("c"),
    }],
  });
  t.end();
  await live.done;
  assertEquals(live.rows.map((r) => r.id), ["c", "b"]);
  live.close();
});
