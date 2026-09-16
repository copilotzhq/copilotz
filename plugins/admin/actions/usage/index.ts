import type { ActionDefinition } from "@copilotz/copilotz/actions";
/** @module Admin projection delegates measurement semantics to Usage queries. */
import { defineAction } from "@copilotz/copilotz/actions";
import {
  type AdminActionContext,
  adminRequestSchema,
  asRequest,
  readOnly,
} from "../../shared/request.ts";
import type { AdminRequest, AdminResponse } from "../../shared/contracts.ts";
export const adminUsageAction: ActionDefinition<
  AdminRequest,
  AdminResponse,
  AdminActionContext
> = defineAction<
  AdminRequest,
  AdminResponse,
  AdminActionContext,
  typeof adminRequestSchema
>({
  id: "copilotz.admin.usage",
  inputSchema: adminRequestSchema,
  async execute(input, context) {
    const request = asRequest(input);
    const rejected = readOnly(request);
    if (rejected) return rejected;
    const query = request.path?.at(-1) === "attempts"
      ? "attempts"
      : "analytics";
    const values = await context.collections.usage.queries[query](
      request.query ?? {},
    );
    return { status: 200, data: values[0] };
  },
});

export default adminUsageAction;
