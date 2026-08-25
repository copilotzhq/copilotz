/** Projects terminal Tool Action facts into their durable plan branch. @module */

import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { CoreToolProcessorContext } from "../../internal/runtime-context.ts";
import { CORE_TOOL_ACTION_METADATA_SCHEMA } from "../../internal/workflow-metadata.ts";
import {
  coreToolTerminal,
  projectAndAdvanceToolPlan,
} from "../../internal/tool-plan.ts";
import { asRecord } from "../internal/helpers.ts";

export const projectToolResultProcessor: Processor<
  CoreToolProcessorContext
> = defineProcessor<CoreToolProcessorContext>({
  id: "copilotz.core.project-tool-result",
  on: ["completed", "failed", "cancelled"].map((status) => ({
    eventType: "*" as const,
    data: {
      status,
      metadata: { schema: CORE_TOOL_ACTION_METADATA_SCHEMA },
    },
  })),
  async handle(event, context) {
    const parsed = coreToolTerminal(event);
    if (!parsed) return;
    if (
      parsed.metadata.action === "ask" &&
      parsed.terminal.status === "completed" &&
      asRecord(parsed.terminal.output).status === "deferred"
    ) return;
    await projectAndAdvanceToolPlan(
      context,
      parsed.metadata,
      parsed.terminal,
      { actionId: parsed.actionId, causationId: parsed.causationId },
    );
  },
});
