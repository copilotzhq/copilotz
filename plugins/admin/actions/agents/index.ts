/** @module Admin agents Action primitive. */
import { defineAction } from "@copilotz/copilotz/actions";
import type { AgentResource } from "@copilotz/copilotz/core";
import {
  type AdminActionContext,
  adminRequestSchema,
  asRequest,
  readOnly,
} from "../internal/request.ts";
import type { AdminRequest, AdminResponse } from "../../internal/contracts.ts";

function publicAgent(agent: AgentResource): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    capabilities: structuredClone(agent.capabilities ?? {}),
  };
}

/** Lists public Agent Resource fields without private instructions. */
export const adminAgentsAction = defineAction<
  AdminRequest,
  AdminResponse,
  AdminActionContext,
  typeof adminRequestSchema
>({
  id: "copilotz.admin.agents",
  inputSchema: adminRequestSchema,
  execute(input, context) {
    const request = asRequest(input);
    const rejected = readOnly(request);
    if (rejected) return rejected;
    return {
      status: 200,
      data: Object.values(context.resources.agents).filter((
        agent,
      ): agent is AgentResource => Boolean(agent)).map(publicAgent),
    };
  },
});
