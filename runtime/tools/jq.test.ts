import { assertEquals, assertRejects } from "@std/assert";
import { disconnectJqWorker, evaluateJq } from "./jq.ts";

Deno.test({
  name: "evaluateJq runs real jq filters in an isolated worker",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    try {
      assertEquals(
        await evaluateJq(
          { items: [{ id: 1, active: true }, { id: 2, active: false }] },
          "[.items[] | select(.active) | {id}]",
        ),
        [{ id: 1 }],
      );
      assertEquals(await evaluateJq("hello", "{content:.}"), {
        content: "hello",
      });
    } finally {
      disconnectJqWorker();
    }
  },
});

Deno.test({
  name: "evaluateJq rejects multiple outputs with collection guidance",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    try {
      await assertRejects(
        () => evaluateJq([1, 2], ".[]"),
        Error,
        "wrap the filter in [...]",
      );
    } finally {
      disconnectJqWorker();
    }
  },
});

Deno.test({
  name: "evaluateJq reports invalid filters",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    try {
      await assertRejects(
        () => evaluateJq({ ok: true }, ".["),
        Error,
      );
    } finally {
      disconnectJqWorker();
    }
  },
});
