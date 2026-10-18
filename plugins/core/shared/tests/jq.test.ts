import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createJqAdmission, type JqClock } from "../jq-admission.ts";
import {
  type CoreJqWorker,
  createCoreJqEvaluator,
  mergePipelineArguments,
} from "../jq.ts";

class Clock implements JqClock {
  time = 0;
  next = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now() {
    return this.time;
  }
  schedule(callback: () => void, delayMs: number) {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return () => {
      this.timers.delete(id);
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

class FakeWorker implements CoreJqWorker {
  onmessage: CoreJqWorker["onmessage"] = null;
  onerror: CoreJqWorker["onerror"] = null;
  requests: Parameters<CoreJqWorker["postMessage"]>[0][] = [];
  terminations = 0;
  postError?: Error;
  terminateError?: Error;
  onTerminate?: () => void;
  postMessage(request: Parameters<CoreJqWorker["postMessage"]>[0]) {
    if (this.postError) throw this.postError;
    this.requests.push(request);
  }
  terminate() {
    this.terminations++;
    this.onTerminate?.();
    if (this.terminateError) throw this.terminateError;
  }
  respond(data: unknown) {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
  success(value: unknown = "ok") {
    this.respond({ ok: true, value: [value] });
  }
}

async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function fixture(setup?: (worker: FakeWorker) => void) {
  const clock = new Clock();
  const workers: FakeWorker[] = [];
  const admission = createJqAdmission({
    activeLimit: 1,
    pendingLimit: 128,
    waitMs: 30_000,
  }, clock);
  const evaluate = createCoreJqEvaluator({
    admission,
    clock,
    createWorker() {
      const worker = new FakeWorker();
      workers.push(worker);
      setup?.(worker);
      return worker;
    },
  });
  return { clock, workers, admission, evaluate };
}

function countedSignal() {
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
  return { controller, count: () => listeners };
}

Deno.test("jq validates input before allocation and snapshots queued JSON", async () => {
  const f = fixture();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const input of [undefined, 1n, circular, "x".repeat(1024 * 1024)]) {
    await assertRejects(() => f.evaluate(input, "."));
  }
  await assertRejects(() => f.evaluate({}, "  "), Error, "filter is empty");
  const abort = new AbortController();
  abort.abort(new Error("pre-aborted"));
  await assertRejects(
    () => f.evaluate({}, ".", abort.signal),
    Error,
    "pre-aborted",
  );
  const abortOnSerialize = new AbortController();
  await assertRejects(
    () =>
      f.evaluate(
        {
          toJSON() {
            abortOnSerialize.abort(new Error("serialization abort"));
            return {};
          },
        },
        ".",
        abortOnSerialize.signal,
      ),
    Error,
    "serialization abort",
  );
  assertEquals(f.workers.length, 0);
  const first = f.evaluate(null, ".");
  await flush();
  assertEquals(f.workers[0].requests, [{ input: "null", filter: "." }]);
  const input = { value: 1 };
  const next = f.evaluate(input, ".");
  input.value = 2;
  f.workers[0].success();
  await first;
  await flush();
  assertEquals(f.workers[1].requests, [{ input: '{"value":1}', filter: "." }]);
  f.workers[1].success(null);
  assertEquals(await next, null);
  assertEquals(f.clock.timers.size, 0);
});

Deno.test("jq cancellation queued and between grant and continuation allocates no Worker", async () => {
  const f = fixture();
  const first = await f.admission.acquire();
  const queued = countedSignal();
  const cancelled = f.evaluate({}, ".", queued.controller.signal);
  const rejection = assertRejects(() => cancelled, Error, "queued abort");
  queued.controller.abort(new Error("queued abort"));
  await rejection;
  assertEquals(queued.count(), 0);
  const granted = countedSignal();
  const afterGrant = f.evaluate({}, ".", granted.controller.signal);
  const afterGrantError = assertRejects(() => afterGrant, Error, "grant abort");
  first.release();
  granted.controller.abort(new Error("grant abort"));
  await afterGrantError;
  assertEquals(f.workers.length, 0);
  assertEquals(granted.count(), 0);
  assertEquals(f.clock.timers.size, 0);
  const next = f.evaluate({}, ".");
  await flush();
  f.workers[0].success();
  await next;
});

Deno.test("jq abort during construction terminates once without posting", async () => {
  const abort = countedSignal();
  const f = fixture(() =>
    abort.controller.abort(new Error("constructor abort"))
  );
  await assertRejects(
    () => f.evaluate({}, ".", abort.controller.signal),
    Error,
    "constructor abort",
  );
  assertEquals(f.workers[0].requests.length, 0);
  assertEquals(f.workers[0].terminations, 1);
  assertEquals(f.clock.timers.size, 0);
  assertEquals(abort.count(), 0);
  const permit = await f.admission.acquire();
  permit.release();
});

Deno.test("jq retains a separate post-constructor five-second active budget", async () => {
  const f = fixture(() => f.clock.advance(700, false));
  const held = await f.admission.acquire();
  const result = f.evaluate({}, ".");
  const failure = assertRejects(
    () => result,
    Error,
    "5 second execution limit",
  );
  f.clock.advance(29_999);
  held.release();
  await flush();
  assertEquals(f.workers.length, 1);
  assertEquals([...f.clock.timers.values()].map((timer) => timer.at), [35_699]);
  f.clock.advance(4_999);
  assertEquals(f.workers[0].terminations, 0);
  f.clock.advance(1);
  await failure;
  assertEquals(f.workers[0].terminations, 1);
  assertEquals(f.clock.timers.size, 0);
});

Deno.test("jq expiry and overflow never allocate workers and use distinct queue errors", async () => {
  const f = fixture();
  const held = await f.admission.acquire();
  const pending = Array.from({ length: 128 }, () => {
    const value = f.evaluate({}, ".");
    return assertRejects(() => value, Error, "30 second admission wait limit");
  });
  await assertRejects(
    () => f.evaluate({}, "."),
    Error,
    "128 waiting evaluations",
  );
  f.clock.advance(30_000, false);
  held.release();
  await Promise.all(pending);
  assertEquals(f.workers.length, 0);
  assertEquals(f.clock.timers.size, 0);
});

Deno.test("jq constructor failure releases ownership and captures runtime dependencies", async () => {
  const f = fixture();
  const options = {
    admission: f.admission,
    clock: f.clock,
    createWorker: () => {
      throw new Error("constructor failed");
    },
  };
  const evaluate = createCoreJqEvaluator(options);
  options.createWorker = () => {
    throw new Error("mutated factory");
  };
  await assertRejects(() => evaluate({}, "."), Error, "constructor failed");
  const next = f.evaluate({}, ".");
  await flush();
  f.workers[0].success();
  await next;
  assertEquals(f.clock.timers.size, 0);
});

for (
  const outcome of [
    "success",
    "jq-error",
    "worker-error",
    "post-error",
    "null-message",
    "undefined-output",
    "circular-output",
    "oversized-output",
    "zero-output",
    "two-outputs",
    "scalar-output",
    "timeout",
    "abort",
    "terminate-error",
  ] as const
) {
  Deno.test(`jq ${outcome} cleans all ownership and ignores late callbacks`, async () => {
    const abort = countedSignal();
    const f = fixture((worker) => {
      if (outcome === "post-error") worker.postError = new Error("post failed");
      if (outcome === "terminate-error") {
        worker.terminateError = new Error("terminate failed");
      }
    });
    const result = f.evaluate({}, ".", abort.controller.signal);
    const terminal = outcome === "success"
      ? result
      : assertRejects(() => result);
    await flush();
    const worker = f.workers[0];
    const oldMessage = worker.onmessage;
    const oldError = worker.onerror;
    switch (outcome) {
      case "success":
      case "terminate-error":
        worker.success("result");
        break;
      case "jq-error":
        worker.respond({ ok: false, error: "bad jq" });
        break;
      case "worker-error":
        worker.onerror?.({ message: "load failed" } as ErrorEvent);
        break;
      case "post-error":
        break;
      case "null-message":
        worker.respond(null);
        break;
      case "undefined-output":
        worker.respond({ ok: true, value: undefined });
        break;
      case "circular-output": {
        const value: unknown[] = [];
        value.push(value);
        worker.respond({ ok: true, value });
        break;
      }
      case "oversized-output":
        worker.success("x".repeat(1024 * 1024));
        break;
      case "zero-output":
        worker.respond({ ok: true, value: [] });
        break;
      case "two-outputs":
        worker.respond({ ok: true, value: [1, 2] });
        break;
      case "scalar-output":
        worker.respond({ ok: true, value: 1 });
        break;
      case "timeout":
        f.clock.advance(5_000);
        break;
      case "abort":
        abort.controller.abort(new Error("active abort"));
        break;
    }
    const value = await terminal;
    if (outcome === "success") assertEquals(value, "result");
    assertEquals(worker.terminations, 1);
    assertEquals(worker.onmessage, null);
    assertEquals(worker.onerror, null);
    assertEquals(f.clock.timers.size, 0);
    assertEquals(abort.count(), 0);
    oldMessage?.(
      { data: { ok: true, value: ["late"] } } as MessageEvent<unknown>,
    );
    oldError?.({ message: "late error" } as ErrorEvent);
    abort.controller.abort(new Error("late abort"));
    f.clock.advance(30_000);
    assertEquals(worker.terminations, 1);
    assertEquals(f.clock.timers.size, 0);
    const permit = await f.admission.acquire();
    permit.release();
  });
}

Deno.test("jq termination reentrancy preserves older waiters and the primary error", async () => {
  const f = fixture();
  const first = f.evaluate({}, ".");
  const firstError = assertRejects(
    () => first,
    Error,
    "jq failed: original failure",
  );
  await flush();
  const second = f.evaluate({ order: 2 }, ".");
  let third: Promise<unknown> | undefined;
  f.workers[0].onTerminate = () => {
    third = f.evaluate({ order: 3 }, ".");
  };
  f.workers[0].terminateError = new Error("cleanup failed");
  f.workers[0].respond({ ok: false, error: "original failure" });
  await firstError;
  await flush();
  assertEquals(f.workers.length, 2);
  assertEquals(f.workers[1].requests[0].input, '{"order":2}');
  f.workers[1].success(2);
  assertEquals(await second, 2);
  await flush();
  assertEquals(f.workers[2].requests[0].input, '{"order":3}');
  f.workers[2].success(3);
  assertEquals(await third, 3);
  assertEquals(f.workers.map((worker) => worker.terminations), [1, 1, 1]);
  assertEquals(f.clock.timers.size, 0);
});

Deno.test("jq admits 47 fake evaluations one at a time with fixed production limits", async () => {
  const f = fixture();
  const results = Array.from(
    { length: 47 },
    (_, branch) => f.evaluate({ branch }, "."),
  );
  for (let branch = 0; branch < 47; branch++) {
    await flush();
    assertEquals(f.workers.length, branch + 1);
    assertEquals(
      f.workers[branch].requests[0].input,
      JSON.stringify({ branch }),
    );
    assertEquals(
      f.workers.filter((worker) => worker.terminations === 0).length,
      1,
    );
    f.workers[branch].success(branch);
  }
  assertEquals(
    await Promise.all(results),
    Array.from({ length: 47 }, (_, branch) => branch),
  );
  assertEquals(f.clock.timers.size, 0);
});

Deno.test("jq argument merge retains explicit nested values and protected keys", () => {
  const source = { nested: { left: 1, right: 2 }, array: [1] };
  assertEquals(
    mergePipelineArguments(source, { nested: { right: 3 }, array: [2] }),
    { nested: { left: 1, right: 3 }, array: [2] },
  );
  assertEquals(source, { nested: { left: 1, right: 2 }, array: [1] });
  assertThrows(() => mergePipelineArguments([], {}), Error, "plain object");
  for (const key of ["__proto__", "prototype", "constructor"]) {
    assertThrows(
      () => mergePipelineArguments({}, JSON.parse(`{"${key}":1}`)),
      Error,
      "not allowed",
    );
  }
});

Deno.test("jq active timer registration failure terminates the allocated worker and releases", async () => {
  const clock = new Clock();
  clock.schedule = () => {
    throw new Error("active timer registration failed");
  };
  const admission = createJqAdmission({
    activeLimit: 1,
    pendingLimit: 128,
    waitMs: 30_000,
  }, clock);
  const worker = new FakeWorker();
  const abort = countedSignal();
  const evaluate = createCoreJqEvaluator({
    admission,
    clock,
    createWorker: () => worker,
  });
  await assertRejects(
    () => evaluate({}, ".", abort.controller.signal),
    Error,
    "active timer registration failed",
  );
  assertEquals(worker.terminations, 1);
  assertEquals(worker.requests.length, 0);
  assertEquals(worker.onmessage, null);
  assertEquals(worker.onerror, null);
  assertEquals(abort.count(), 0);
  (await admission.acquire()).release();
});

Deno.test("jq throwing cleanup still detaches and terminates while preserving the first error", async () => {
  for (const outcome of ["success", "failure"] as const) {
    const clock = new Clock();
    const schedule = clock.schedule.bind(clock);
    clock.schedule = (callback, delay) => {
      const cancel = schedule(callback, delay);
      return () => {
        cancel();
        throw new Error("active timer cleanup failed");
      };
    };
    const admission = createJqAdmission({
      activeLimit: 1,
      pendingLimit: 128,
      waitMs: 30_000,
    }, clock);
    const worker = new FakeWorker();
    worker.terminateError = new Error("secondary termination failure");
    const abort = countedSignal();
    const remove = abort.controller.signal.removeEventListener.bind(
      abort.controller.signal,
    );
    abort.controller.signal.removeEventListener = (
      ...args: Parameters<typeof remove>
    ) => {
      remove(...args);
      throw new Error("secondary listener cleanup failure");
    };
    const evaluate = createCoreJqEvaluator({
      admission,
      clock,
      createWorker: () => worker,
    });
    const result = evaluate({}, ".", abort.controller.signal);
    const rejected = assertRejects(
      () => result,
      Error,
      outcome === "success"
        ? "active timer cleanup failed"
        : "jq failed: original failure",
    );
    await flush();
    if (outcome === "success") worker.success();
    else worker.respond({ ok: false, error: "original failure" });
    await rejected;
    assertEquals(worker.terminations, 1);
    assertEquals(worker.onmessage, null);
    assertEquals(worker.onerror, null);
    assertEquals(abort.count(), 0);
    assertEquals(clock.timers.size, 0);
    (await admission.acquire()).release();
  }
});

Deno.test("jq abort-listener setup failure uses terminal cleanup", async () => {
  const f = fixture();
  const abort = countedSignal();
  const add = abort.controller.signal.addEventListener.bind(
    abort.controller.signal,
  );
  abort.controller.signal.addEventListener = (
    ...args: Parameters<typeof add>
  ) => {
    add(...args);
    throw new Error("listener registration failed");
  };
  await assertRejects(
    () => f.evaluate({}, ".", abort.controller.signal),
    Error,
    "listener registration failed",
  );
  assertEquals(f.workers[0].terminations, 1);
  assertEquals(f.workers[0].requests.length, 0);
  assertEquals(abort.count(), 0);
  assertEquals(f.clock.timers.size, 0);
  (await f.admission.acquire()).release();
});
