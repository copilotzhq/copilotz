/** @module Admin threads Action primitive. */
import { defineAction } from "@copilotz/copilotz/actions";
import {
  allMessages,
  allThreads,
  messagePreview,
  pageInfo,
  queryLimit,
  queryText,
  queryTexts,
  record,
} from "../internal/projections.ts";
import {
  type AdminActionContext,
  adminRequestSchema,
  asRequest,
  readOnly,
} from "../internal/request.ts";
import type { AdminRequest, AdminResponse } from "../../internal/contracts.ts";

function metadataText(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : undefined;
}

/** Lists projected conversation threads with bounded pagination. */
export const adminThreadsAction = defineAction<
  AdminRequest,
  AdminResponse,
  AdminActionContext,
  typeof adminRequestSchema
>({
  id: "copilotz.admin.threads",
  inputSchema: adminRequestSchema,
  async execute(input, context) {
    const request = asRequest(input);
    const rejected = readOnly(request);
    if (rejected) return rejected;
    const limit = queryLimit(request);
    const order = queryText(request, "order") ?? "desc";
    if (order !== "asc" && order !== "desc") {
      throw new TypeError("order must be asc or desc.");
    }
    const statuses = queryTexts(request, "status")?.filter((value) =>
      value !== "all"
    );
    const search = queryText(request, "search")?.toLowerCase();
    let values = [
      ...await allThreads(context, {
        participantId: queryText(request, "participantId"),
        status: statuses?.length ? statuses : undefined,
        order,
      }),
    ];
    const after = queryText(request, "after");
    if (after) {
      const index = values.findIndex((value) => value.id === after);
      if (index < 0) throw new Error(`Thread cursor '${after}' was not found.`);
      values = values.slice(index + 1);
    }
    if (search) {
      values = values.filter((thread) =>
        JSON.stringify({
          id: thread.id,
          externalId: thread.externalId,
          metadata: thread.metadata,
        }).toLowerCase().includes(search)
      );
    }
    const selected = values.slice(0, limit);
    const data = [];
    for (const thread of selected) {
      const messages = await allMessages(context, thread.id);
      data.push({
        id: thread.id,
        threadId: thread.id,
        externalId: thread.externalId ?? null,
        name: metadataText(record(thread.metadata), "name") ??
          thread.externalId ?? thread.id,
        summary: metadataText(record(thread.metadata), "summary") ?? null,
        status: thread.status,
        participantIds: Array.isArray(thread.participantIds)
          ? thread.participantIds
          : [],
        messageCount: messages.length,
        lastActivityAt: thread.lastEventAt ?? thread.updatedAt,
        lastMessagePreview: await messagePreview(context, messages.at(-1)),
        metadata: thread.metadata,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      });
    }
    return { status: 200, data, pageInfo: pageInfo(selected, limit) };
  },
});
