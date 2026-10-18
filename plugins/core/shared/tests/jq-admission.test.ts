import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createJqAdmission, type JqClock } from "../jq-admission.ts";

class Clock implements JqClock {
  time = 0;
  next = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  onCancel?: () => void;
  now() {
    return this.time;
  }
  schedule(callback: () => void, delayMs: number) {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return () => {
      this.timers.delete(id);
      this.onCancel?.();
    };
  }
  advance(ms: number, callbacks = true) {
    this.time += ms;
    if (!callbacks) return;
    for (;;) {
      const due = [...this.timers].find(([, timer]) => timer.at <= this.time);
      if (!due) break;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

const defaults = { activeLimit: 1, pendingLimit: 128, waitMs: 30_000 };

Deno.test("jq admission validates and privately captures its limits and clock", async () => {
  for (const activeLimit of [0, -1, 1.5, Infinity, NaN]) {
    assertThrows(() => createJqAdmission({ ...defaults, activeLimit }));
  }
  for (const pendingLimit of [-1, 1.5, Infinity, NaN]) {
    assertThrows(() => createJqAdmission({ ...defaults, pendingLimit }));
  }
  for (const waitMs of [0, -1, Infinity, NaN]) {
    assertThrows(() => createJqAdmission({ ...defaults, waitMs }));
  }
  const clock = new Clock();
  const options = { activeLimit: 1, pendingLimit: 1, waitMs: 30_000 };
  const gate = createJqAdmission(options, clock);
  options.activeLimit = 100;
  options.pendingLimit = 100;
  options.waitMs = Infinity;
  const first = await gate.acquire();
  const waiting = gate.acquire();
  const expired = assertRejects(
    () => waiting,
    Error,
    "30 second admission wait",
  );
  await assertRejects(() => gate.acquire(), Error, "1 waiting evaluations");
  clock.now = () => -Infinity;
  clock.schedule = () => {
    throw new Error("mutated clock function");
  };
  clock.advance(30_000);
  await expired;
  first.release();
  assertEquals(clock.timers.size, 0);
});

Deno.test("jq admission charges grants before continuation and preserves FIFO for 47", async () => {
  const clock = new Clock();
  const gate = createJqAdmission(defaults, clock);
  const first = await gate.acquire();
  const order: number[] = [];
  let owned = 0;
  let maxOwned = 0;
  const pending = Array.from(
    { length: 46 },
    (_, index) =>
      gate.acquire().then((permit) => {
        owned++;
        maxOwned = Math.max(maxOwned, owned);
        order.push(index);
        owned--;
        permit.release();
        permit.release();
      }),
  );
  first.release();
  first.release();
  // The first queued promise has resolved but its continuation has not run.
  const newcomer = gate.acquire().then((permit) => {
    order.push(46);
    permit.release();
  });
  await Promise.all([...pending, newcomer]);
  assertEquals(order, Array.from({ length: 47 }, (_, index) => index));
  assertEquals(maxOwned, 1);
  assertEquals(clock.timers.size, 0);
});

Deno.test("jq admission permits exactly 128 pending and rejects overflow without eviction", async () => {
  const clock = new Clock();
  const gate = createJqAdmission(defaults, clock);
  const first = await gate.acquire();
  const pending = Array.from(
    { length: 128 },
    () => gate.acquire().then((permit) => permit.release()),
  );
  assertEquals(clock.timers.size, 128);
  await assertRejects(() => gate.acquire(), Error, "128 waiting evaluations");
  first.release();
  await Promise.all(pending);
  assertEquals(clock.timers.size, 0);
});

Deno.test("jq admission expires at equality even when the timer callback is delayed", async () => {
  for (const runCallbacks of [false, true]) {
    const clock = new Clock();
    const gate = createJqAdmission(defaults, clock);
    const first = await gate.acquire();
    const pending = gate.acquire();
    const expired = assertRejects(
      () => pending,
      Error,
      "30 second admission wait",
    );
    clock.advance(30_000, runCallbacks);
    first.release();
    await expired;
    const next = await gate.acquire();
    next.release();
    assertEquals(clock.timers.size, 0);
  }
});

Deno.test("jq admission removes expired heads and cancelled interior waiters in FIFO order", async () => {
  const clock = new Clock();
  const gate = createJqAdmission(defaults, clock);
  const first = await gate.acquire();
  const head = gate.acquire();
  const expired = assertRejects(() => head, Error, "admission wait limit");
  clock.advance(1_000, false);
  const abort = new AbortController();
  const middle = gate.acquire(abort.signal);
  const cancelled = assertRejects(() => middle, DOMException, "cancel middle");
  const order: number[] = [];
  const tail = gate.acquire().then((permit) => {
    order.push(1);
    permit.release();
  });
  abort.abort(new DOMException("cancel middle", "AbortError"));
  clock.advance(29_000, false);
  first.release();
  await Promise.all([expired, cancelled, tail]);
  assertEquals(order, [1]);
  assertEquals(clock.timers.size, 0);
});

Deno.test("jq admission rejects pre-abort and cleans queue abort timer and listener", async () => {
  const clock = new Clock();
  const gate = createJqAdmission(defaults, clock);
  const abort = new AbortController();
  abort.abort(new Error("before admission"));
  await assertRejects(
    () => gate.acquire(abort.signal),
    Error,
    "before admission",
  );
  const first = await gate.acquire();
  const controller = new AbortController();
  let listeners = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args: Parameters<typeof add>) => {
    listeners++;
    add(...args);
  };
  controller.signal.removeEventListener = (
    ...args: Parameters<typeof remove>
  ) => {
    listeners--;
    remove(...args);
  };
  const pending = gate.acquire(controller.signal);
  const cancelled = assertRejects(() => pending, Error, "cancel queued");
  assertEquals(listeners, 1);
  controller.abort(new Error("cancel queued"));
  await cancelled;
  first.release();
  assertEquals(listeners, 0);
  assertEquals(clock.timers.size, 0);
});

Deno.test("jq admission timer and abort cleanup reentrancy cannot bypass older waiters", async () => {
  for (const action of ["grant", "expiry", "abort"] as const) {
    const clock = new Clock();
    const gate = createJqAdmission(defaults, clock);
    const first = await gate.acquire();
    const controller = new AbortController();
    const order: string[] = [];
    const head = gate.acquire(controller.signal);
    const headResult = action === "grant"
      ? head.then((permit) => {
        order.push("head");
        permit.release();
      })
      : assertRejects(() => head);
    clock.advance(1_000, false);
    const tail = gate.acquire().then((permit) => {
      order.push("tail");
      permit.release();
    });
    let reentrant: Promise<void> | undefined;
    clock.onCancel = () => {
      clock.onCancel = undefined;
      reentrant = gate.acquire().then((permit) => {
        order.push("new");
        permit.release();
      });
    };
    if (action === "expiry") clock.advance(29_000);
    if (action === "abort") controller.abort();
    first.release();
    await Promise.all([headResult, tail]);
    await reentrant;
    assertEquals(
      order,
      action === "grant" ? ["head", "tail", "new"] : ["tail", "new"],
    );
    assertEquals(clock.timers.size, 0);
  }
});

Deno.test("jq admission scheduling failure removes its rejected waiter before releasing", async () => {
  const clock = new Clock();
  const schedule = clock.schedule.bind(clock);
  let registrations = 0;
  clock.schedule = (callback, delay) => {
    if (++registrations === 1) {
      throw new Error("queue timer registration failed");
    }
    return schedule(callback, delay);
  };
  const gate = createJqAdmission(defaults, clock);
  const first = await gate.acquire();
  await assertRejects(
    () => gate.acquire(),
    Error,
    "queue timer registration failed",
  );
  const next = gate.acquire();
  first.release();
  (await next).release();
  assertEquals(clock.timers.size, 0);
});

Deno.test("jq admission throwing timer cleanup preserves first errors and survivor FIFO", async () => {
  for (const action of ["grant", "expiry", "abort"] as const) {
    const clock = new Clock();
    const gate = createJqAdmission(defaults, clock);
    const first = await gate.acquire();
    const controller = new AbortController();
    const head = gate.acquire(controller.signal);
    const headError = assertRejects(
      () => head,
      Error,
      action === "grant"
        ? "timer cleanup failed"
        : action === "expiry"
        ? "admission wait limit"
        : "original abort",
    );
    clock.advance(1_000, false);
    const order: string[] = [];
    const tail = gate.acquire().then((permit) => {
      order.push("tail");
      permit.release();
    });
    let newRequest: Promise<void> | undefined;
    clock.onCancel = () => {
      clock.onCancel = undefined;
      newRequest = gate.acquire().then((permit) => {
        order.push("new");
        permit.release();
      });
      throw new Error("timer cleanup failed");
    };
    if (action === "expiry") clock.advance(29_000);
    if (action === "abort") controller.abort(new Error("original abort"));
    first.release();
    await Promise.all([headError, tail]);
    await newRequest;
    assertEquals(order, ["tail", "new"]);
    assertEquals(clock.timers.size, 0);
    (await gate.acquire()).release();
  }
});
