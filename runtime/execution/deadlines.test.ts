import { assert, assertEquals, assertThrows } from "@std/assert";
import { defineAction, isActionDefinition } from "../actions/define.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { DELIVERY_DEADLINE_MS, resolveDeliveryTimeoutMs } from "./deadlines.ts";
import { createOwnerWorkerWorkloads } from "./owner-capability-worker.ts";
import { createOwnerCapabilityHost } from "./owner-capabilities.ts";
import { encodeCapability } from "./owner-capability-wire.ts";

Deno.test("delivery backstop defaults to hours and reserves registered nested Action bounds", () => {
  assertEquals(DELIVERY_DEADLINE_MS, 6 * 60 * 60_000);
  assertEquals(resolveDeliveryTimeoutMs(), DELIVERY_DEADLINE_MS);
  const research = defineAction({
    id: "research.long",
    deliveryTimeoutMs: 8 * 60 * 60_000,
    execute: () => undefined,
  });
  assert(isActionDefinition(research));
  assertEquals(
    resolveDeliveryTimeoutMs(undefined, { research }),
    8 * 60 * 60_000,
  );
  assertEquals(resolveDeliveryTimeoutMs(100, { research }), 8 * 60 * 60_000);
  assertEquals(resolveDeliveryTimeoutMs(100), 100);
  for (const invalid of [0, -1, NaN, Infinity, 1.5, 0x8000_0000]) {
    assertThrows(() => resolveDeliveryTimeoutMs(invalid), RangeError);
    assertThrows(
      () => defineAction({ ...research, deliveryTimeoutMs: invalid }),
      RangeError,
    );
    assertEquals(
      isActionDefinition({ ...research, deliveryTimeoutMs: invalid }),
      false,
    );
  }
});

Deno.test("owner and worker host-call limits honor the same nested Action bound", async () => {
  const registry = createPluginRegistry({
    actions: {
      research: defineAction({
        id: "research.long",
        deliveryTimeoutMs: 8000,
        execute: () => undefined,
      }),
    },
  });
  const host = createOwnerCapabilityHost({
    registry,
    localExecution: true,
    deliveryTimeoutMs: 5000,
    createWorkloads: () => ({}),
    resolveAuthority: () =>
      Promise.resolve({ epoch: 1, signal: new AbortController().signal }),
  });
  try {
    assertEquals(host.workerCalls.timeoutMs, 8000);
    let calls = 0;
    const workload = createOwnerWorkerWorkloads({
      registry,
      deliveryTimeoutMs: 5000,
    })["copilotz.delivery.v1"];
    await workload({
      streamId: "delivery",
      workload: "copilotz.delivery.v1",
      metadata: {},
      signal: new AbortController().signal,
      input: new ReadableStream({ start: (c) => c.close() }),
      sendMetadata: () => Promise.resolve(),
      callHost(input) {
        calls++;
        const remaining = input.deadlineAtMs! - Date.now();
        assert(remaining > 7900 && remaining <= 8000);
        return Promise.resolve({
          streamId: "call",
          started: Promise.resolve(),
          completed: Promise.resolve(),
          metadata: Promise.resolve({}),
          cancel: () => Promise.resolve(),
          output: new ReadableStream({
            start(c) {
              c.enqueue(encodeCapability({ value: { done: true } }));
              c.close();
            },
          }),
        });
      },
    });
    assert(calls > 0);
  } finally {
    await host.close();
  }
});
