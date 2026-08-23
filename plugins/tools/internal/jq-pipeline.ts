import type {
  ToolPipeline,
  ToolPipelineStage,
  ToolPipelineToolStage,
} from "../../llm/internal/types.ts";
import { isPlainObject, mergePipelineArguments } from "./pipeline.ts";
import type {
  WorkflowJqEvaluator,
  WorkflowPipelineAdvance,
  WorkflowPipelineMetadata,
} from "./types.ts";

function toolStage(
  stage: ToolPipelineStage | undefined,
): stage is ToolPipelineToolStage {
  return stage?.type === "tool" && typeof stage.id === "string" &&
    typeof stage.tool?.id === "string" && typeof stage.args === "string";
}

function requiredPipelineId(value: string): string {
  const id = value.trim();
  if (!id) throw new TypeError("Tool pipeline id must be non-empty.");
  return id;
}

function cloneStages(
  stages: readonly ToolPipelineStage[],
): readonly ToolPipelineStage[] {
  return Object.freeze(structuredClone([...stages]));
}

/** Normalizes the model-produced plan stored on the root execution. */
export function createWorkflowPipelineMetadata(
  pipeline: ToolPipeline,
): WorkflowPipelineMetadata {
  const stages = cloneStages(pipeline.stages);
  const root = stages[0];
  if (!toolStage(root)) {
    throw new Error("A tool pipeline must begin with a valid tool stage.");
  }
  return Object.freeze({
    id: requiredPipelineId(pipeline.id),
    stages,
    stageIndex: 0,
    rootToolCallId: root.id,
  });
}

function explicitArguments(stage: ToolPipelineToolStage) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stage.args);
  } catch (error) {
    throw new Error(
      `Invalid downstream tool arguments: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error("Invalid downstream tool arguments: expected an object.");
  }
  return parsed;
}

/**
 * Advances one completed actual tool stage through zero or more internal jq
 * stages. jq frames are not durable; the next actual tool remains a normal
 * durable tool execution.
 */
export async function advanceWorkflowPipeline(
  input: Readonly<{
    pipeline: WorkflowPipelineMetadata;
    output: unknown;
    upstreamToolExecutionId: string;
    evaluateJq: WorkflowJqEvaluator;
  }>,
): Promise<WorkflowPipelineAdvance> {
  const { pipeline } = input;
  if (
    !Number.isSafeInteger(pipeline.stageIndex) || pipeline.stageIndex < 0 ||
    pipeline.stageIndex >= pipeline.stages.length ||
    !toolStage(pipeline.stages[pipeline.stageIndex])
  ) {
    return Object.freeze({
      kind: "failed",
      stageIndex: pipeline.stageIndex,
      message: "PIPELINE ERROR: Invalid current pipeline stage.",
    });
  }
  if (pipeline.stageIndex >= pipeline.stages.length - 1) {
    return Object.freeze({ kind: "settled", output: input.output });
  }

  let output = input.output;
  let nextIndex = pipeline.stageIndex + 1;
  const applied = [...(pipeline.appliedJqStageIndexes ?? [])];
  try {
    while (
      nextIndex < pipeline.stages.length &&
      pipeline.stages[nextIndex]?.type === "jq"
    ) {
      const stage = pipeline.stages[nextIndex];
      if (stage.type !== "jq" || !stage.filter.trim()) {
        throw new Error("jq filter is empty.");
      }
      output = await input.evaluateJq(output, stage.filter);
      applied.push(nextIndex);
      nextIndex += 1;
    }

    if (nextIndex >= pipeline.stages.length) {
      return Object.freeze({
        kind: "settled",
        output,
        projected: true,
      });
    }

    const stage = pipeline.stages[nextIndex];
    if (!toolStage(stage)) {
      throw new Error("Pipeline expected a valid tool stage.");
    }
    const arguments_ = mergePipelineArguments(
      output,
      explicitArguments(stage),
    );
    const nextPipeline: WorkflowPipelineMetadata = Object.freeze({
      ...structuredClone(pipeline),
      stages: cloneStages(pipeline.stages),
      stageIndex: nextIndex,
      upstreamToolExecutionId: input.upstreamToolExecutionId,
      ...(applied.length
        ? { appliedJqStageIndexes: Object.freeze(applied) }
        : {}),
    });
    return Object.freeze({
      kind: "next_tool",
      stage,
      stageIndex: nextIndex,
      arguments: Object.freeze(arguments_),
      pipeline: nextPipeline,
    });
  } catch (error) {
    return Object.freeze({
      kind: "failed",
      stageIndex: nextIndex,
      message: `PIPELINE ERROR: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}
