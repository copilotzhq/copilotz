import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";

import {
  advanceWorkflowPipeline,
  createWorkflowPipelineMetadata,
} from "./pipeline.ts";

const metadata = createWorkflowPipelineMetadata({
  id: "pipeline-1",
  stages: [
    {
      type: "tool",
      id: "root-call",
      tool: { id: "extract" },
      args: "{}",
    },
    { type: "jq", filter: "{customer:.customer,tags:.tags}" },
    {
      type: "tool",
      id: "next-call",
      tool: { id: "analyze" },
      args: JSON.stringify({
        customer: { status: "priority" },
        tags: ["manual"],
        notify: true,
      }),
    },
  ],
});

Deno.test("pipeline advancement applies jq and deep-merges explicit arguments", async () => {
  const result = await advanceWorkflowPipeline({
    pipeline: metadata,
    output: {
      customer: { id: "123", status: "new" },
      tags: ["imported"],
    },
    upstreamToolExecutionId: "execution-1",
    evaluateJq(input, filter) {
      assertStringIncludes(filter, "customer");
      return input;
    },
  });
  assertEquals(result.kind, "next_tool");
  if (result.kind !== "next_tool") return;
  assertEquals(result.stage.id, "next-call");
  assertEquals(result.arguments, {
    customer: { id: "123", status: "priority" },
    tags: ["manual"],
    notify: true,
  });
  assertEquals(result.pipeline.stageIndex, 2);
  assertEquals(result.pipeline.upstreamToolExecutionId, "execution-1");
  assertEquals(result.pipeline.appliedJqStageIndexes, [1]);
});

Deno.test("pipeline ending in jq settles with the transformed value", async () => {
  const ending = createWorkflowPipelineMetadata({
    id: "pipeline-ending-jq",
    stages: [
      {
        type: "tool",
        id: "root-call",
        tool: { id: "extract" },
        args: "{}",
      },
      { type: "jq", filter: ".records | map(.id)" },
    ],
  });
  const result = await advanceWorkflowPipeline({
    pipeline: ending,
    output: { records: [{ id: 1 }, { id: 2 }] },
    upstreamToolExecutionId: "execution-1",
    evaluateJq: () => [1, 2],
  });
  assertEquals(result, { kind: "settled", output: [1, 2], projected: true });
});

Deno.test("pipeline errors become deterministic failed advances", async () => {
  const nonObject = createWorkflowPipelineMetadata({
    id: "pipeline-non-object",
    stages: [
      {
        type: "tool",
        id: "root-call",
        tool: { id: "extract" },
        args: "{}",
      },
      {
        type: "tool",
        id: "next-call",
        tool: { id: "analyze" },
        args: "{}",
      },
    ],
  });
  const result = await advanceWorkflowPipeline({
    pipeline: nonObject,
    output: "plain text",
    upstreamToolExecutionId: "execution-1",
    evaluateJq: (input) => input,
  });
  assertEquals(result.kind, "failed");
  if (result.kind === "failed") {
    assertStringIncludes(result.message, "Pipeline output must be an object");
  }
});

Deno.test("pipeline metadata rejects a jq root", () => {
  assertThrows(
    () =>
      createWorkflowPipelineMetadata({
        id: "invalid",
        stages: [{ type: "jq", filter: "." }],
      }),
    Error,
    "must begin with a valid tool stage",
  );
});
