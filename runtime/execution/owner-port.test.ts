import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRegisteredOwnerExecutionPort,
  ownerClaimKey,
  ownerCompletionKey,
} from "./owner-port.ts";
import type { OwnerCommand, OwnerJson } from "../owner/boundary.ts";
const ref = {
  executionId: "run",
  deliveryId: "delivery",
  dispatchAttemptId: "attempt",
};
const done = { ...ref, status: "completed" as const };
function fixture() {
  const commands: OwnerCommand[] = [];
  const completions: OwnerCommand[] = [];
  const projections: unknown[] = [];
  const reads: string[] = [];
  const receipts = new Map<string, { kind: string; result: OwnerJson }>();
  const adapter = createRegisteredOwnerExecutionPort({
    ownerId: "owner",
    namespace: "space",
    port: {
      execute(command) {
        commands.push(command);
        return Promise.resolve({ status: "committed", result: ref });
      },
      complete(command) {
        completions.push(command);
        return Promise.resolve({ status: "committed", result: done });
      },
      project(kind, input) {
        projections.push({ kind, input });
        return Promise.resolve(null);
      },
      readReceipt(identity) {
        reads.push(identity.key);
        return Promise.resolve(receipts.get(identity.key));
      },
    },
  });
  return { adapter, commands, completions, projections, reads, receipts };
}
test("owner execution mapper shares deterministic data-only claim and terminal keys", async () => {
  const f = fixture();
  assert.deepEqual(
    await f.adapter.claim(
      { assignmentId: "assignment", sessionId: "session" },
      {},
    ),
    { status: "committed", result: ref },
  );
  assert.deepEqual(f.commands, [{
    kind: "execution.claim",
    domain: "incarnation",
    key: ownerClaimKey("owner", "assignment", "session"),
    intent: { assignmentId: "assignment", sessionId: "session" },
  }]);
  await f.adapter.project(ref, {});
  assert.deepEqual(f.projections, [{ kind: "execution.input", input: ref }]);
  await f.adapter.complete(
    ref,
    { status: "completed", output: { ok: true } },
    {},
  );
  assert.deepEqual(f.completions, [{
    kind: "execution.complete",
    domain: "logical",
    key: ownerCompletionKey("owner", "space", "run"),
    intent: {
      namespace: "space",
      executionId: "run",
      completion: { status: "completed", output: { ok: true } },
    },
  }]);
  assert.equal(
    JSON.stringify(f.completions).includes("dispatchAttemptId"),
    false,
  );
});
test("settled claim replay returns exact safe references without commands or projection", async () => {
  const f = fixture();
  f.receipts.set(ownerClaimKey("owner", "assignment", "session"), {
    kind: "execution.claim",
    result: ref,
  });
  f.receipts.set(ownerCompletionKey("owner", "space", "run"), {
    kind: "execution.complete",
    result: done,
  });
  assert.deepEqual(
    await f.adapter.claim(
      { assignmentId: "assignment", sessionId: "session" },
      {},
    ),
    { status: "duplicate", result: ref },
  );
  assert.deepEqual(await f.adapter.readCompletion(ref, {}), done);
  assert.equal(
    f.commands.length + f.completions.length + f.projections.length,
    0,
  );
});
test("ambiguous prior claim never executes again and wrong attempt or unsafe recovery refuses", async () => {
  const f = fixture();
  f.receipts.set(ownerClaimKey("owner", "assignment", "session"), {
    kind: "execution.claim",
    result: ref,
  });
  await assert.rejects(
    f.adapter.claim({ assignmentId: "assignment", sessionId: "session" }, {}),
    /recovery is unavailable/,
  );
  for (
    const result of [{ ...done, dispatchAttemptId: "replacement" }, {
      ...done,
      input: "private",
    }, { ...done, status: "started" }]
  ) {
    f.receipts.set(ownerCompletionKey("owner", "space", "run"), {
      kind: "execution.complete",
      result,
    });
    await assert.rejects(
      f.adapter.readCompletion(ref, {}),
      /recovery is unavailable/,
    );
  }
  assert.equal(
    f.commands.length + f.completions.length + f.projections.length,
    0,
  );
});
test("routing coordinates and references are required without implying authority", async () => {
  const f = fixture();
  await assert.rejects(
    f.adapter.claim({ assignmentId: "", sessionId: "session" }, {}),
    /nonempty/,
  );
  await assert.rejects(
    f.adapter.project({ ...ref, executionId: "" }, {}),
    /recovery is unavailable/,
  );
  assert.equal(f.reads.length + f.commands.length + f.projections.length, 0);
});

test("mapper refuses old references and rebinding before calling restricted completion", async () => {
  const f = fixture();
  await f.adapter.claim(
    { assignmentId: "assignment", sessionId: "session" },
    {},
  );
  await assert.rejects(
    f.adapter.complete({ ...ref, dispatchAttemptId: "old-attempt" }, {
      status: "completed",
      output: null,
    }, {}),
  );
  assert.equal(f.completions.length, 0);
  await assert.rejects(
    f.adapter.claim({ assignmentId: "replacement", sessionId: "session" }, {}),
  );
  assert.equal(f.commands.length, 1);
  const fresh = fixture();
  await assert.rejects(
    fresh.adapter.complete(ref, { status: "completed", output: null }, {}),
  );
  assert.equal(fresh.completions.length, 0);
});
