import type { CoreToolProcessorContext } from "../../shared/runtime-context.ts";
import { parseActionLifecycleEvent } from "@copilotz/copilotz/actions";
import type { Processor } from "@copilotz/copilotz/plugins";
import {
  type CoreToolActionMetadata,
  coreToolActionMetadata,
} from "../../shared/workflow-metadata.ts";
import type { ToolTerminal } from "../../shared/tool-plan.ts";
import {
  asRecord as record,
  requiredText as text,
} from "../../shared/validation.ts";

export function coreToolTerminal(
  event: Parameters<Processor<CoreToolProcessorContext>["handle"]>[0],
):
  | Readonly<
    {
      metadata: CoreToolActionMetadata;
      terminal: ToolTerminal;
      actionId: string;
      causationId?: string;
    }
  >
  | null {
  const lifecycle = parseActionLifecycleEvent(event, {
    statuses: ["completed", "failed", "cancelled"],
    requireRoot: true,
  });
  if (!lifecycle) return null;
  const metadata = coreToolActionMetadata(lifecycle.metadata);
  if (
    !metadata ||
    (lifecycle.status !== "completed" && lifecycle.status !== "failed" &&
      lifecycle.status !== "cancelled")
  ) return null;
  return {
    metadata,
    actionId: lifecycle.actionId,
    ...(event.causationId ? { causationId: event.causationId } : {}),
    terminal: lifecycle.status === "completed"
      ? {
        actionRunId: text(lifecycle.actionRunId, "Tool Action run ID"),
        sourceAction: {
          stageIndex: metadata.stageIndex,
          actionRunId: lifecycle.actionRunId,
        },
        status: "completed",
        input: lifecycle.input,
        output: lifecycle.output,
      }
      : {
        actionRunId: text(lifecycle.actionRunId, "Tool Action run ID"),
        sourceAction: {
          stageIndex: metadata.stageIndex,
          actionRunId: lifecycle.actionRunId,
        },
        status: lifecycle.status,
        input: lifecycle.input,
        error: record(lifecycle.error),
      },
  };
}
