/** @module Admin activity Action primitive. */
import { defineAction } from "@copilotz/copilotz/actions";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  allCollectionRecords,
  finite,
  inDateRange,
  optionalDate,
  queryText,
} from "../internal/projections.ts";
import {
  type AdminActionContext,
  adminRequestSchema,
  asRequest,
  readOnly,
} from "../internal/request.ts";
import type {
  AdminActivityPoint,
  AdminRequest,
  AdminResponse,
} from "../../internal/contracts.ts";

type ActivityInterval = "hour" | "day" | "week" | "month";

function interval(request: AdminRequest): ActivityInterval {
  const value = queryText(request, "interval") ?? "day";
  if (
    value === "hour" || value === "day" || value === "week" || value === "month"
  ) return value;
  throw new TypeError("interval must be hour, day, week, or month.");
}

function bucket(value: string, unit: ActivityInterval): string {
  const date = new Date(value);
  if (unit === "month") {
    date.setUTCDate(1);
    date.setUTCHours(0, 0, 0, 0);
  } else if (unit === "week") {
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() - day + 1);
    date.setUTCHours(0, 0, 0, 0);
  } else if (unit === "day") {
    date.setUTCHours(0, 0, 0, 0);
  } else {
    date.setUTCMinutes(0, 0, 0);
  }
  return date.toISOString();
}

type MutableActivityPoint = {
  -readonly [Key in keyof AdminActivityPoint]: AdminActivityPoint[Key];
};

function emptyActivity(bucketValue: string): MutableActivityPoint {
  return {
    bucket: bucketValue,
    messageCount: 0,
    toolCallCount: 0,
    totalCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  };
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

/** Returns bucketed message and usage activity. */
export const adminActivityAction = defineAction<
  AdminRequest,
  AdminResponse,
  AdminActionContext,
  typeof adminRequestSchema
>({
  id: "copilotz.admin.activity",
  inputSchema: adminRequestSchema,
  async execute(input, context) {
    const request = asRequest(input);
    const rejected = readOnly(request);
    if (rejected) return rejected;
    const unit = interval(request);
    const range = dates(request);
    const [messages, usage] = await Promise.all([
      allCollectionRecords(context, "message"),
      allCollectionRecords(context, "usage"),
    ]);
    const points = new Map<string, MutableActivityPoint>();
    const point = (createdAt: string) => {
      const key = bucket(createdAt, unit);
      const existing = points.get(key) ?? emptyActivity(key);
      points.set(key, existing);
      return existing;
    };
    for (const message of messages) {
      if (!inDateRange(message.createdAt, range.from, range.to)) continue;
      point(message.createdAt).messageCount += 1;
    }
    for (const value of usage) {
      if (!createdInRange(value, range)) continue;
      if (value.kind !== "tool" && value.kind !== "llm") continue;
      const occurredAt = typeof value.occurredAt === "string"
        ? value.occurredAt
        : value.createdAt;
      const current = point(occurredAt);
      if (value.kind === "tool") {
        current.toolCallCount += 1;
        continue;
      }
      current.totalCalls += 1;
      current.inputTokens += finite(value.inputTokens);
      current.outputTokens += finite(value.outputTokens);
      current.reasoningTokens += finite(value.reasoningTokens);
      current.totalTokens += finite(value.totalTokens);
      current.totalCostUsd += finite(value.totalCostUsd);
    }
    return {
      status: 200,
      data: [...points.values()].sort((left, right) =>
        left.bucket.localeCompare(right.bucket)
      ),
    };
  },
});
