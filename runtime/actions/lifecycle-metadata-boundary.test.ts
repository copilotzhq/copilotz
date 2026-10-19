import { assertEquals, assertRejects } from "@std/assert";
import type { EventCoordinator, EventStore } from "../events/index.ts";
import { defineAction } from "./define.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import { createActionLifecycleAppender } from "./persistence.ts";
import type { ProtectedValueRuntime } from "./protected-value.ts";
import { secret } from "./secret.ts";

Deno.test("first lifecycle capture refuses input-secret metadata without protected Action hooks", async () => {
  const action = defineAction({
    id: "fixture.lifecycle-boundary",
    inputSchema: {
      type: "object",
      properties: { token: secret({ type: "string" }) },
      required: ["token"],
    } as const,
    execute: () => true,
  });
  let encrypted = 0;
  let committed = 0;
  const append = createActionLifecycleAppender({
    actions: { use: action },
    store: {} as EventStore,
    coordinator: {
      commitMutation() {
        committed++;
        throw new Error("Unexpected persistence");
      },
    } as unknown as EventCoordinator,
    protectedValues: {
      prepare() {
        encrypted++;
        throw new Error("Unexpected encryption");
      },
    } as unknown as ProtectedValueRuntime,
  });
  for (const token of ["private-input-token", 'private-\nquoted:"value']) {
    for (const origin of [false, true]) {
      const lifecycle = createActionLifecycleEmitter({
        namespace: "main",
        append,
        metadata: origin ? { leaked: token } : {},
      });
      await assertRejects(
        () =>
          lifecycle.emit({
            actionId: action.id,
            actionRunId: "run-1",
            input: { token },
            metadata: origin ? {} : { leaked: token },
            status: "invoked",
            deduplicationId: "run-1:action:invoked",
          }),
        TypeError,
        "metadata cannot contain",
      );
    }
  }
  assertEquals(encrypted, 0);
  assertEquals(committed, 0);
});
