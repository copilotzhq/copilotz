import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeContext } from "../actions/types.ts";
import type { ProcessorContext } from "../plugins/processor.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { processorFixture } from "../owner/processor.fixture.test.ts";

test("Processor direct Collection writes route through owner and close retained capabilities", async () => {
  let retained!: ProcessorContext;
  const f = await processorFixture({
    processor: defineProcessor({
      id: "fixture.observe",
      on: [{ eventType: "fixture.source" }],
      async handle(_event, ctx) {
        retained = ctx;
        await ctx.collections.notes.create({ id: "direct", title: "ordinary" });
      },
    }),
  });
  try {
    assert.equal(
      (await f.worker().execute(f.hint())).receipt.status,
      "succeeded",
    );
    assert.equal(
      (await f.db.query("SELECT * FROM nodes WHERE id='direct'")).rows.length,
      1,
    );
    assert.equal(retained.signal.aborted, true);
    assert.throws(
      () => retained.collections.notes.create({ id: "late" }),
      /closed/,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM nodes WHERE id='late'")).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("Processor catches cannot hide unsupported Collection options or missing nested Action capability", async () => {
  for (const mode of ["options", "actions"] as const) {
    const f = await processorFixture({
      processor: defineProcessor({
        id: "fixture.observe",
        on: [{ eventType: "fixture.source" }],
        async handle(_event, ctx) {
          try {
            if (mode === "options") {
              await ctx.collections.notes.create(
                { id: "forbidden" },
                { condition: { title: "ignored" } } as never,
              );
            } else {await (ctx.actions
                .echo as RuntimeContext["actions"][string])({
                  title: "unavailable",
                });}
          } catch {
            /* A refused capability remains failed even when caught. */
          }
        },
      }),
    });
    try {
      const result = await f.worker().execute(f.hint());
      assert.equal(result.receipt.status, "dead_letter");
      assert.equal(
        result.status === "executed" && result.completion.status === "failed" &&
          result.completion.code,
        "processor_capability_unsupported",
      );
      assert.equal((await f.db.query("SELECT * FROM nodes")).rows.length, 0);
    } finally {
      await f.close();
    }
  }
});

test("Processor nested Action bridge receives local key and exact durable parent reference only", async () => {
  let call: unknown;
  const f = await processorFixture({
    invokeAction(input) {
      call = input;
      return Promise.reject(
        new Error(
          "named adapter deliberately unavailable in this unit test",
        ),
      );
    },
    processor: defineProcessor({
      id: "fixture.observe",
      on: [{ eventType: "fixture.source" }],
      async handle(_event, ctx) {
        await (ctx.actions.echo as RuntimeContext["actions"][string])({
          title: "child",
        }, { operationKey: "next" });
      },
    }),
  });
  try {
    assert.equal(
      (await f.worker().execute(f.hint())).receipt.status,
      "retry_wait",
    );
    assert.deepEqual(call, {
      reference: f.reference(),
      actionAlias: "echo",
      input: { title: "child" },
      operationKey: "next",
    });
  } finally {
    await f.close();
  }
});

for (
  const mode of ["collection", "command", "action", "transaction"] as const
) {
  test(`Processor unsupported nested ${mode} access latches refusal even when caught`, async () => {
    const nested = (value: unknown) =>
      void (value as { missing: { nested: unknown } }).missing.nested;
    const f = await processorFixture({
      processor: defineProcessor({
        id: "fixture.observe",
        on: [{ eventType: "fixture.source" }],
        async handle(_event, ctx) {
          if (mode === "transaction") {
            await ctx.transaction(({ collections }) => {
              try {
                nested(collections.notes);
              } catch { /* latch survives */ }
            }, { operationKey: "unsupported" });
          } else {
            try {
              nested(
                mode === "collection"
                  ? ctx.collections.notes
                  : mode === "command"
                  ? ctx.collections.notes.commands
                  : ctx.actions.echo,
              );
            } catch { /* latch survives */ }
          }
        },
      }),
    });
    try {
      const result = await f.worker().execute(f.hint());
      assert.equal(result.receipt.status, "dead_letter");
      assert.equal(
        result.status === "executed" && result.completion.status === "failed" &&
          result.completion.code,
        "processor_capability_unsupported",
      );
      assert.equal((await f.db.query("SELECT * FROM nodes")).rows.length, 0);
    } finally {
      await f.close();
    }
  });
}

test("Processor content Collection planning is explicitly nonretryable and never writes", async () => {
  const f = await processorFixture({ contentCollection: true });
  try {
    const result = await f.worker().execute(f.hint());
    assert.equal(result.receipt.status, "dead_letter");
    assert.equal(
      result.status === "executed" && result.completion.status === "failed" &&
        result.completion.code,
      "processor_capability_unsupported",
    );
    assert.equal((await f.db.query("SELECT * FROM nodes")).rows.length, 0);
  } finally {
    await f.close();
  }
});

test("Processor nested Action keys match public trimming and implicit index semantics", async () => {
  const keys: string[] = [];
  const f = await processorFixture({
    invokeAction(input) {
      keys.push(input.operationKey);
      return Promise.reject(
        new Error("No successful child result is fabricated."),
      );
    },
    processor: defineProcessor({
      id: "fixture.observe",
      on: [{ eventType: "fixture.source" }],
      async handle(_event, ctx) {
        for (
          const operationKey of [
            "  named  ",
            undefined,
            "  ",
            "explicit",
            undefined,
          ]
        ) {
          try {
            await (ctx.actions.echo as RuntimeContext["actions"][string])({}, {
              operationKey,
            });
          } catch { /* Every failed invocation remains tracked. */ }
        }
      },
    }),
  });
  try {
    assert.equal(
      (await f.worker().execute(f.hint())).receipt.status,
      "retry_wait",
    );
    assert.deepEqual(keys, ["named", "1", "2", "explicit", "3"]);
  } finally {
    await f.close();
  }
});
