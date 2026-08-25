/** @module Admin participants Action primitive. */
import { defineAction } from "@copilotz/copilotz/actions";
import {
  allMessages,
  allParticipants,
  allThreads,
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

/** Lists conversation participants and their derived activity. */
export const adminParticipantsAction = defineAction<
  AdminRequest,
  AdminResponse,
  AdminActionContext,
  typeof adminRequestSchema
>({
  id: "copilotz.admin.participants",
  inputSchema: adminRequestSchema,
  async execute(input, context) {
    const request = asRequest(input);
    const rejected = readOnly(request);
    if (rejected) return rejected;
    const limit = queryLimit(request);
    const type = queryText(request, "type") ??
      queryText(request, "participantType");
    const search = queryText(request, "search")?.toLowerCase();
    let values = [...await allParticipants(context)];
    if (type && type !== "all") {
      values = values.filter((participant) =>
        participant.participantType === type
      );
    }
    const after = queryText(request, "after");
    if (after) {
      const index = values.findIndex((value) => value.id === after);
      if (index < 0) {
        throw new Error(`Participant cursor '${after}' was not found.`);
      }
      values = values.slice(index + 1);
    }
    if (search) {
      values = values.filter((participant) =>
        JSON.stringify(participant).toLowerCase().includes(search)
      );
    }
    const selected = values.slice(0, limit);
    const data = [];
    for (const participant of selected) {
      const participantThreads = await allThreads(context, {
        participantId: participant.id,
      });
      let messageCount = 0;
      let lastActivityAt: string | null = null;
      for (const thread of participantThreads) {
        const messages = await allMessages(context, thread.id);
        messageCount += messages.filter((message) =>
          message.senderId === participant.id
        ).length;
        const candidate = String(thread.lastEventAt ?? thread.updatedAt);
        if (!lastActivityAt || candidate > lastActivityAt) {
          lastActivityAt = candidate;
        }
      }
      data.push({
        id: participant.id,
        externalId: participant.externalId,
        displayName: participant.name ?? participant.externalId,
        participantType: participant.participantType,
        namespace: participant.namespace,
        messageCount,
        threadCount: participantThreads.length,
        lastActivityAt,
        metadata: participant.metadata,
        createdAt: participant.createdAt,
        updatedAt: participant.updatedAt,
      });
    }
    return { status: 200, data, pageInfo: pageInfo(selected, limit) };
  },
});
