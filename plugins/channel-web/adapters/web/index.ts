/**
 * Defines the in-process Web Channel Adapter.
 *
 * @module
 */

import { base64ToBytes, parseDataUrl } from "@copilotz/copilotz/content";
import { cloneChannelJson } from "../../../channel-core/authoring/channel-ingress/index.ts";
import type {
  ChannelAdapter,
  ChannelIngressOccurrence,
  ChannelJsonObject,
  ChannelMessageVisibility,
  ChannelParticipantInput,
  ChannelParticipantRef,
  ChannelThreadInput,
} from "../../../channel-core/internal/contracts.ts";

const MEDIA_TYPES = new Set(["image", "audio", "video", "file"]);
const VISIBILITIES = new Set<ChannelMessageVisibility>([
  "public",
  "participants",
  "internal",
]);

function required(value: unknown, label: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${label} must be non-empty.`);
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  const cloned = cloneChannelJson(value, label);
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  return cloned as Record<string, unknown>;
}

function webContent(value: unknown): unknown {
  if (typeof value === "string") return value;
  const item = record(value, "Web Channel content");
  if (typeof item.type !== "string" || !MEDIA_TYPES.has(item.type)) {
    return item;
  }
  const data = typeof item.dataBase64 === "string"
    ? {
      bytes: base64ToBytes(item.dataBase64),
      mediaType: typeof item.mediaType === "string"
        ? item.mediaType
        : "application/octet-stream",
    }
    : typeof item.dataUrl === "string"
    ? parseDataUrl(item.dataUrl)
    : null;
  if (!data) {
    throw new TypeError(
      `Web Channel ${item.type} content requires dataBase64 or dataUrl.`,
    );
  }
  const { dataBase64: _dataBase64, dataUrl: _dataUrl, ...rest } = item;
  return Object.freeze({
    ...rest,
    bytes: data.bytes,
    mediaType: typeof item.mediaType === "string"
      ? required(item.mediaType, "Web Channel media type")
      : data.mediaType,
  });
}

function content(value: unknown): unknown {
  return Array.isArray(value)
    ? Object.freeze(value.map(webContent))
    : webContent(value);
}

function participant(value: unknown, label: string): ChannelParticipantInput {
  const input = record(value, label);
  return Object.freeze({
    ...(typeof input.id === "string"
      ? { id: required(input.id, `${label} ID`) }
      : {}),
    externalId: required(input.externalId, `${label} external ID`),
    participantType: required(
      input.participantType,
      `${label} participant type`,
    ) as ChannelParticipantInput["participantType"],
    ...(typeof input.name === "string"
      ? { name: required(input.name, `${label} name`) }
      : {}),
    ...(typeof input.email === "string"
      ? { email: required(input.email, `${label} email`) }
      : {}),
    ...(typeof input.agentId === "string"
      ? { agentId: required(input.agentId, `${label} Agent ID`) }
      : {}),
    ...(input.metadata && typeof input.metadata === "object"
      ? { metadata: input.metadata as ChannelJsonObject }
      : {}),
  });
}

function thread(value: unknown): ChannelThreadInput {
  const input = record(value, "Web Channel thread");
  const participants = input.participants === undefined
    ? undefined
    : Array.isArray(input.participants)
    ? Object.freeze(
      input.participants.map((value, index) =>
        typeof value === "string"
          ? required(value, `Web Channel thread participant[${index}]`)
          : participant(value, `Web Channel thread participant[${index}]`)
      ),
    ) as readonly ChannelParticipantRef[]
    : (() => {
      throw new TypeError("Web Channel thread participants must be an array.");
    })();
  return Object.freeze({
    ...(typeof input.name === "string"
      ? { name: required(input.name, "Web Channel thread name") }
      : {}),
    ...(typeof input.description === "string"
      ? {
        description: required(
          input.description,
          "Web Channel thread description",
        ),
      }
      : {}),
    ...(typeof input.status === "string"
      ? { status: required(input.status, "Web Channel thread status") }
      : {}),
    ...(input.metadata && typeof input.metadata === "object"
      ? { metadata: input.metadata as ChannelJsonObject }
      : {}),
    ...(participants ? { participants } : {}),
  });
}

/** Converts one typed Web body into a durable occurrence and worker semantics. */
export function createWebChannelAdapter(): ChannelAdapter {
  return Object.freeze({
    accept(request) {
      const body = record(request.body, "Web Channel request body");
      if (request.method !== "POST") {
        throw Object.assign(new Error("Method not allowed."), {
          status: 405,
          code: "method_not_allowed",
        });
      }
      const actor = request.context?.actor as {
        id?: string;
        externalId?: string;
        name?: string;
        email?: string;
      } | undefined;
      if (!actor?.id) {
        throw Object.assign(new Error("Authentication required."), {
          status: 401,
          code: "unauthorized",
        });
      }
      if (
        Object.keys(body).some((key) =>
          !["externalThreadId", "content", "recipientIds"].includes(key)
        ) || !("content" in body)
      ) {
        throw Object.assign(new Error("Invalid Web Channel input."), {
          status: 400,
          code: "invalid_input",
        });
      }
      const recipients = body.recipientIds === undefined
        ? undefined
        : body.recipientIds;
      if (
        recipients !== undefined &&
        (!Array.isArray(recipients) ||
          recipients.some((value) =>
            typeof value !== "string" || !value.trim()
          ))
      ) {
        throw Object.assign(new Error("Recipient IDs must be strings."), {
          status: 400,
          code: "invalid_input",
        });
      }
      const key = required(
        request.headers["idempotency-key"],
        "Idempotency-Key",
      );
      const occurrence: ChannelIngressOccurrence = Object.freeze({
        id: `${actor.id}:${key}`,
        input: cloneChannelJson({
          externalThreadId: `${actor.id}:${
            required(body.externalThreadId, "Web Channel external thread ID")
          }`,
          sender: {
            ...actor,
            externalId: actor.externalId ?? actor.id,
            participantType: "human",
          },
          content: body.content,
          ...(recipients ? { recipients } : {}),
          metadata: { clientMessageId: key },
        }, "Web Channel input"),
      });
      return Object.freeze({
        status: 202,
        response: Object.freeze({ accepted: true }),
        occurrences: Object.freeze([occurrence]),
      });
    },
    receive(value) {
      const input = record(value, "Web Channel input");
      const recipients = Array.isArray(input.recipients)
        ? Object.freeze(
          input.recipients.map((value, index) =>
            typeof value === "string"
              ? required(value, `Web Channel recipient[${index}]`)
              : participant(value, `Web Channel recipient[${index}]`)
          ),
        ) as readonly ChannelParticipantRef[]
        : undefined;
      const visibility = input.visibility === undefined ? undefined : required(
        input.visibility,
        "Web Channel visibility",
      ) as ChannelMessageVisibility;
      if (visibility && !VISIBILITIES.has(visibility)) {
        throw new TypeError("Web Channel visibility is invalid.");
      }
      return Object.freeze({
        externalThreadId: required(
          input.externalThreadId,
          "Web Channel external thread ID",
        ),
        sender: participant(input.sender, "Web Channel sender"),
        ...(recipients ? { recipients } : {}),
        content: content(input.content) as never,
        ...(input.thread && typeof input.thread === "object"
          ? { thread: thread(input.thread) }
          : {}),
        ...(input.route && typeof input.route === "object"
          ? { route: input.route as ChannelJsonObject }
          : {}),
        ...(input.metadata && typeof input.metadata === "object"
          ? { metadata: input.metadata as ChannelJsonObject }
          : {}),
        ...(visibility ? { visibility } : {}),
      });
    },
  });
}
