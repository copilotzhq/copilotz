/** @module Admin usage Action primitive. */
import { defineAction } from "@copilotz/copilotz/actions";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  allCollectionRecords,
  inDateRange,
  optionalDate,
  pageInfo,
  queryLimit,
  queryText,
} from "../internal/projections.ts";
import {
  type AdminActionContext,
  adminRequestSchema,
  asRequest,
  readOnly,
} from "../internal/request.ts";
import type { AdminRequest, AdminResponse } from "../../internal/contracts.ts";

function exactUsageWhere(
  request: AdminRequest,
): Record<string, unknown> | undefined {
  const keys = [
    "kind",
    "provider",
    "model",
    "agentId",
    "threadId",
    "initiatedById",
    "status",
  ];
  const where: Record<string, unknown> = {};
  for (const key of keys) {
    const value = queryText(request, key);
    if (value && value !== "all") where[key] = value;
  }
  return Object.keys(where).length ? where : undefined;
}

function dates(request: AdminRequest) {
  return {
    from: optionalDate(queryText(request, "from")),
    to: optionalDate(queryText(request, "to")),
  };
}

function createdInRange(
  value: CollectionRecord,
  range: ReturnType<typeof dates>,
): boolean {
  const occurredAt = typeof value.occurredAt === "string"
    ? value.occurredAt
    : value.createdAt;
  return inDateRange(occurredAt, range.from, range.to);
}

/** Lists typed usage records with exact filters and bounded pagination. */
export const adminUsageAction = defineAction<
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
    const limit = queryLimit(request);
    let values = [
      ...await allCollectionRecords(context, "usage", exactUsageWhere(request)),
    ];
    const range = dates(request);
    values = values.filter((value) => createdInRange(value, range));
    const after = queryText(request, "after");
    if (after) {
      const index = values.findIndex((value) => value.id === after);
      if (index < 0) throw new Error(`Usage cursor '${after}' was not found.`);
      values = values.slice(index + 1);
    }
    const selected = values.slice(0, limit);
    return {
      status: 200,
      data: selected,
      pageInfo: pageInfo(selected, limit),
    };
  },
});
