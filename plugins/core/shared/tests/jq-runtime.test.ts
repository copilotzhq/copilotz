import { assertEquals } from "@std/assert";
import { evaluateCoreJq } from "../jq.ts";
import type { JqWorkerRequest } from "../jq-worker.ts";

Deno.test("production jq admission runs 47 evaluations in FIFO order with one worker", async () => {
  let active = 0;
  let maximum = 0;
  const order: number[] = [];
  class Worker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = false;
    constructor() {
      active++;
      maximum = Math.max(maximum, active);
    }
    postMessage(request: JqWorkerRequest) {
      const { branch } = JSON.parse(request.input);
      order.push(branch);
      queueMicrotask(() =>
        this.onmessage?.(
          new MessageEvent("message", { data: { ok: true, value: [branch] } }),
        )
      );
    }
    terminate() {
      if (this.terminated) return;
      this.terminated = true;
      active--;
    }
  }
  const original = globalThis.Worker;
  globalThis.Worker = Worker as unknown as typeof globalThis.Worker;
  try {
    const expected = Array.from({ length: 47 }, (_, branch) => branch);
    const results = await Promise.all(
      expected.map((branch) => evaluateCoreJq({ branch }, ".")),
    );
    assertEquals(results, expected);
    assertEquals(order, expected);
    assertEquals(active, 0);
    assertEquals(maximum, 1);
  } finally {
    globalThis.Worker = original;
  }
});
