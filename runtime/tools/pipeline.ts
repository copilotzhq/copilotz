import type {
  ToolPipeline,
  ToolPipelineStage,
  ToolPipelineToolStage,
} from "@/runtime/llm/types.ts";

export const TOOL_PIPELINE_METADATA_KEY = "toolPipeline";

export interface ToolPipelineExecutionMetadata {
  id: string;
  stages: ToolPipelineStage[];
  stageIndex: number;
  rootToolCallId: string;
  upstreamToolExecutionId?: string;
  appliedJqStageIndexes?: number[];
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (
    value === null || typeof value === "string" ||
    typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Pipeline values cannot contain NaN or Infinity.");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(
      `Pipeline values must be JSON-compatible; received ${typeof value}.`,
    );
  }
  if (seen.has(value)) {
    throw new Error("Pipeline values cannot contain circular references.");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => cloneJsonValue(entry, seen));
    }
    if (!isPlainObject(value)) {
      throw new Error(
        `Pipeline values must use plain JSON objects; received ${
          value.constructor?.name ?? "object"
        }.`,
      );
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new Error(`Pipeline object key "${key}" is not allowed.`);
      }
      result[key] = cloneJsonValue(entry, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function serializePipelineValue(value: unknown): string {
  return JSON.stringify(cloneJsonValue(value));
}

function mergeObjects(
  piped: Record<string, unknown>,
  explicit: Record<string, unknown>,
): Record<string, unknown> {
  const result = cloneJsonValue(piped) as Record<string, unknown>;
  for (const [key, explicitValue] of Object.entries(explicit)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`Pipeline argument key "${key}" is not allowed.`);
    }
    const pipedValue = result[key];
    result[key] = isPlainObject(pipedValue) && isPlainObject(explicitValue)
      ? mergeObjects(pipedValue, explicitValue)
      : cloneJsonValue(explicitValue);
  }
  return result;
}

/** Deep merge pipeline output into explicit arguments; explicit values win. */
export function mergePipelineArguments(
  pipedOutput: unknown,
  explicitArguments: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainObject(pipedOutput)) {
    throw new Error(
      'Pipeline output must be an object before a tool stage. Add a jq stage such as {"jq":"{input:.}"} to shape it.',
    );
  }
  return mergeObjects(pipedOutput, explicitArguments);
}

export function parsePipelineMetadata(
  value: unknown,
): ToolPipelineExecutionMetadata | null {
  if (!isPlainObject(value)) return null;
  if (
    typeof value.id !== "string" || !Array.isArray(value.stages) ||
    !Number.isInteger(value.stageIndex)
  ) return null;
  const root = value.stages[0] as ToolPipelineStage | undefined;
  if (!isToolPipelineStage(root)) return null;
  return {
    ...(value as unknown as ToolPipelineExecutionMetadata),
    rootToolCallId: typeof value.rootToolCallId === "string"
      ? value.rootToolCallId
      : root.id,
  };
}

export function rootPipelineMetadata(
  pipeline: ToolPipeline,
): ToolPipelineExecutionMetadata {
  const root = pipeline.stages[0];
  if (!isToolPipelineStage(root)) {
    throw new Error("A tool pipeline must begin with a tool stage.");
  }
  return {
    id: pipeline.id,
    stages: pipeline.stages,
    stageIndex: 0,
    rootToolCallId: root.id,
  };
}

export function isToolPipelineStage(
  stage: ToolPipelineStage | undefined,
): stage is ToolPipelineToolStage {
  return stage?.type === "tool";
}
