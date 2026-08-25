/** @module Shared Admin Action request validation and schema utilities. */
import type {
  ActionContext,
  RuntimeContextNamespaces,
} from "@copilotz/copilotz/actions";
import type { AgentResource } from "@copilotz/copilotz/core";
import type { AdminRequest, AdminResponse } from "../../internal/contracts.ts";

/** The narrowed runtime context required by the Admin Action primitives. */
export type AdminActionContext = ActionContext<
  & RuntimeContextNamespaces
  & Readonly<{
    agents: Readonly<Record<string, AgentResource | undefined>>;
  }>
>;

/** Shared request schema accepted by each read-only Admin Action. */
export const adminRequestSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    resource: { type: "string" },
    method: { type: "string" },
    path: { type: "array", items: { type: "string" } },
    query: { type: "object" },
    body: {},
    headers: { type: "object" },
    context: { type: "object" },
  },
  required: ["resource", "method"],
} as const;

/** Validates an untyped Action input as an Admin request. */
export function asRequest(input: unknown): AdminRequest {
  if (
    input &&
    typeof input === "object" &&
    "method" in input &&
    typeof (input as { method?: unknown }).method === "string"
  ) {
    return input as AdminRequest;
  }
  throw new TypeError("Admin actions expect an AdminRequest.");
}

/** Returns the standard response for non-GET Admin requests. */
export function readOnly(request: AdminRequest): AdminResponse | undefined {
  return request.method === "GET" ? undefined : {
    status: 405,
    data: {
      code: "method_not_allowed",
      message: "Admin projections are read-only.",
    },
  };
}
