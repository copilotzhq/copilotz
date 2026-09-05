/** Reusable conversation HTTP endpoints; application policy remains in Server. @module */
import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import {
  createHttpAdapter,
  type HttpHandlerContext,
} from "../../../server/authoring/http-adapter/index.ts";
import {
  mapMessageRecord,
  mapParticipantRecord,
  mapThreadRecord,
} from "../../../core-collections/index.ts";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  deleteConversation,
  editConversationMessage,
  sendConversation,
  updateConversation,
} from "./actions.ts";

function query(
  context: HttpHandlerContext,
): import("../client/index.ts").ThreadQuery {
  const value = new URL(context.request.url).searchParams.get("query");
  try {
    const input = value ? JSON.parse(value) : {};
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error();
    }
    if (
      Object.keys(input).some((key) =>
        !["after", "before", "limit", "order", "view", "status"].includes(key)
      ) ||
      input.order !== undefined && !["asc", "desc"].includes(input.order) ||
      input.status !== undefined &&
        !["active", "archived", "closed"].includes(input.status) ||
      [input.after, input.before].some((value) =>
        value !== undefined && typeof value !== "string"
      )
    ) throw new Error();
    return input;
  } catch {
    throw Object.assign(new Error("Query must be a JSON object."), {
      status: 400,
      code: "invalid_query",
    });
  }
}
function membership(context: HttpHandlerContext) {
  if (!context.scope.actor) {
    throw Object.assign(new Error("Authentication required."), {
      status: 401,
      code: "unauthorized",
    });
  }
  // An application can authorize historical identities or administrative access.
  // The read service has already intersected this explicit policy with every query.
  if (context.constraints.collections?.thread) return {};
  return { contains: { participantIds: [context.scope.actor.id] } };
}
async function thread(context: HttpHandlerContext, id: string) {
  const values = await context.read.list("thread", {
    ...membership(context),
    where: { id },
    limit: 1,
  });
  if (!values.length) {
    throw Object.assign(new Error("Thread was not found."), {
      status: 404,
      code: "thread_not_found",
    });
  }
  return values[0];
}
async function project(context: HttpHandlerContext, value: CollectionRecord) {
  const participants = await Promise.all(
    (value.participantIds as string[]).map((id) =>
      context.read.get("participant", id)
    ),
  );
  return mapThreadRecord(
    value,
    participants.filter((value): value is CollectionRecord => value !== null)
      .map(mapParticipantRecord),
  );
}

export function createCoreServerPlugin(): CopilotzPlugin {
  const http = createHttpAdapter({
    routes: [
      {
        id: "core.threads.list",
        method: "GET",
        path: "/threads",
        async handler(context) {
          const input = query(context);
          const limit = input.limit ?? 100;
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 999) {
            throw Object.assign(new Error("Thread limit must be 1 to 999."), {
              status: 400,
              code: "invalid_query",
            });
          }
          const records = await context.read.list("thread", {
            ...input,
            limit: limit + 1,
            order: { field: "updatedAt", direction: input.order ?? "desc" },
            ...(input.status ? { where: { status: input.status } } : {}),
            all: [membership(context)],
          });
          return Response.json({
            data: await Promise.all(
              records.slice(0, limit).map((value) => project(context, value)),
            ),
            pageInfo: {
              hasMore: records.length > limit,
              next: records.length > limit ? records[limit - 1]?.id : undefined,
            },
          });
        },
      },
      {
        id: "core.threads.get",
        method: "GET",
        path: "/threads/:id",
        async handler(context) {
          return await project(
            context,
            await thread(context, context.params.id),
          );
        },
      },
      {
        id: "core.threads.messages",
        method: "GET",
        path: "/threads/:id/messages",
        async handler(context) {
          await thread(context, context.params.id);
          // Capture before the read. Live discovery replays every overlapping operation,
          // including ones that start and settle while history is being projected.
          const checkpoint = await context.operations.checkpoint(
            context.params.id,
          );
          const input = query(context);
          const limit = input.limit ?? 100;
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 999) {
            throw Object.assign(new Error("History limit must be 1 to 999."), {
              status: 400,
              code: "invalid_query",
            });
          }
          const records = await context.read.query("message", "history", {
            ...input,
            threadId: context.params.id,
            limit: limit + 1,
          });
          const messages = await Promise.all(
            records.slice(0, limit).map(async (record) => {
              const sender = await context.read.get(
                "participant",
                String(record.senderId),
              );
              if (!sender) throw new Error("Message sender was not found.");
              return mapMessageRecord(
                record as CollectionRecord,
                mapParticipantRecord(sender),
              );
            }),
          );
          return Response.json({
            data: messages,
            pageInfo: {
              checkpoint,
              hasMore: records.length > limit,
              next: records.length > limit ? messages.at(-1)?.id : undefined,
            },
          });
        },
      },
      {
        id: "core.threads.observe",
        method: "POST",
        path: "/threads/:id/observe",
        responseMediaType: "multipart/mixed",
        inputSchema: {
          type: "object",
          properties: { checkpoint: { type: "string" } },
          additionalProperties: false,
        },
        async handler(context) {
          await thread(context, context.params.id);
          return await context.operations.observe({
            threadId: context.params.id,
            checkpoint: (context.input as { checkpoint?: string }).checkpoint,
          });
        },
      },
    ],
  });
  return definePlugin({
    id: "copilotz.core.server",
    version: "0.66.0",
    actions: {
      sendConversation,
      updateConversation,
      deleteConversation,
      editConversationMessage,
    },
    adapters: { http: { core: http } },
  });
}
