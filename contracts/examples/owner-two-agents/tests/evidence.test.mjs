import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
// Pure evidence-mapping fixture, with an explicit placement spy; no runtime or Worker.
test("evidence keeps canonical source/run identity and refuses conflicting attribution", async () => {
  const source = await readFile(
    new URL("../processors/record-evidence/index.ts", import.meta.url),
    "utf8",
  );
  const body = stripTypeScriptTypes(source, { mode: "strip" }).replace(
    /^import[\s\S]*?;\n/gm,
    "",
  ).replace("export default", "return");
  let placementChecks = 0;
  const processor = Function("defineProcessor", "assertBrowserWorker", body)(
    (value) => value,
    () => placementChecks++,
  );
  const rows = [];
  const context = {
    collections: {
      evidence: {
        create: (value) => {
          rows.push(value);
          return Promise.resolve(value);
        },
      },
    },
  };
  const event = {
    durable: true,
    id: "source-1",
    type: "copilotz.tools.builtin.get_current_time.completed",
    correlationId: "demo-run:one",
    causationId: "cause-1",
    createdAt: "now",
    data: { metadata: { agentId: "reviewer" }, output: {} },
  };
  await processor.handle(event, context);
  assert.equal(rows[0].runId, "one");
  assert.equal(rows[0].sourceId, event.id);
  assert.equal(rows[0].correlationId, event.correlationId);
  assert.equal(rows[0].causationId, event.causationId);
  assert.equal(rows[0].agent, "reviewer");
  await processor.handle({ ...event, correlationId: "unknown" }, context);
  assert.equal(rows[1].runId, "unattributed");
  await assert.rejects(
    () =>
      processor.handle(
        { ...event, data: { output: { runId: "other" } } },
        context,
      ),
    /does not match/,
  );
  assert.equal(rows.length, 2);
  assert.equal(placementChecks, 3);
});
