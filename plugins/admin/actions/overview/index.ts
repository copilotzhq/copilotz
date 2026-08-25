/** @module Admin overview Action primitive. */
import { defineAction } from "@copilotz/copilotz/actions";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  allCollectionRecords,
  allParticipants,
  allThreads,
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
  AdminRequest,
  AdminResponse,
  AdminUsageTotals,
} from "../../internal/contracts.ts";

function usageTotals(records: readonly CollectionRecord[]): AdminUsageTotals {
  return Object.freeze(records.reduce((totals, value) => ({
    totalCalls: totals.totalCalls + 1,
    inputTokens: totals.inputTokens + finite(value.inputTokens),
    outputTokens: totals.outputTokens + finite(value.outputTokens),
    reasoningTokens: totals.reasoningTokens + finite(value.reasoningTokens),
    totalTokens: totals.totalTokens + finite(value.totalTokens),
    totalCostUsd: totals.totalCostUsd + finite(value.totalCostUsd),
  }), {
    totalCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  }));
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

/** Returns aggregate thread, message, participant, and usage totals. */
export const adminOverviewAction = defineAction<
  AdminRequest,
  AdminResponse,
  AdminActionContext,
  typeof adminRequestSchema
>({
  id: "copilotz.admin.overview",
  inputSchema: adminRequestSchema,
  async execute(input, context) {
    const request = asRequest(input);
    const rejected = readOnly(request);
    if (rejected) return rejected;
    const range = dates(request);
    const [threads, messages, participants, usage] = await Promise.all([
      allThreads(context),
      allCollectionRecords(context, "message"),
      allParticipants(context),
      allCollectionRecords(context, "usage"),
    ]);
    const messageTotal = messages.filter((message) =>
      inDateRange(message.createdAt, range.from, range.to)
    ).length;
    const rangedUsage = usage.filter((value) =>
      createdInRange(value, range)
    );
    const llm = rangedUsage.filter((value) => value.kind === "llm");
    const tools = rangedUsage.filter((value) => value.kind === "tool");
    const threadStatus = (status: string) =>
      threads.filter((thread) => thread.status === status).length;
    const participantType = (type: string) =>
      participants.filter((participant) => participant.participantType === type)
        .length;
    return {
      status: 200,
      data: {
        threadTotals: {
          total: threads.length,
          active: threadStatus("active"),
          archived: threadStatus("archived"),
          closed: threadStatus("closed"),
        },
        messageTotals: { total: messageTotal },
        participantTotals: {
          total: participants.length,
          human: participantType("human"),
          agent: participantType("agent"),
          tool: participantType("tool"),
          job: participantType("job"),
        },
        llmTotals: usageTotals(llm),
        toolTotals: usageTotals(tools),
      },
    };
  },
});
