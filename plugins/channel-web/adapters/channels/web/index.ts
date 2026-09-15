/**
 * Defines the in-process Web Channel Adapter.
 *
 * @module
 */

import { decodeContent } from "@copilotz/copilotz/content";
import { cloneChannelJson } from "../../../../channel-core/authoring/channel-ingress/index.ts";
import type {
  ChannelAdapter,
  ChannelIngressOccurrence,
  ChannelJsonObject,
  ChannelMessageVisibility,
  ChannelParticipantInput,
  ChannelParticipantRef,
  ChannelThreadInput,
} from "../../../../channel-core/internal/contracts.ts";

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

function participant(value: unknown, label: string): ChannelParticipantInput {
  const input = record(value, label);
  return ({
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
  } as const);
}

function thread(value: unknown): ChannelThreadInput {
  const input = record(value, "Web Channel thread");
  const participants = input.participants === undefined
    ? undefined
    : Array.isArray(input.participants)
    ? (input.participants.map((value, index) =>
      typeof value === "string"
        ? required(value, `Web Channel thread participant[${index}]`)
        : participant(value, `Web Channel thread participant[${index}]`)
    )) as readonly ChannelParticipantRef[]
    : (() => {
      throw new TypeError("Web Channel thread participants must be an array.");
    })();
  return ({
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
  } as const);
}

/** Converts one typed Web body into a durable occurrence and worker semantics. */

export const webChannelAdapter: ChannelAdapter = {
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
        recipients.some((value) => typeof value !== "string" || !value.trim()))
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
    const occurrence: ChannelIngressOccurrence = {
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
    } as const;
    return ({
      status: 202,
      response: { accepted: true } as const,
      occurrences: [occurrence] as const,
    } as const);
  },
  receive(value) {
    const input = record(value, "Web Channel input");
    const recipients = Array.isArray(input.recipients)
      ? (input.recipients.map((value, index) =>
        typeof value === "string"
          ? required(value, `Web Channel recipient[${index}]`)
          : participant(value, `Web Channel recipient[${index}]`)
      )) as readonly ChannelParticipantRef[]
      : undefined;
    const visibility = input.visibility === undefined ? undefined : required(
      input.visibility,
      "Web Channel visibility",
    ) as ChannelMessageVisibility;
    if (visibility && !VISIBILITIES.has(visibility)) {
      throw new TypeError("Web Channel visibility is invalid.");
    }
    return ({
      externalThreadId: required(
        input.externalThreadId,
        "Web Channel external thread ID",
      ),
      sender: participant(input.sender, "Web Channel sender"),
      ...(recipients ? { recipients } : {}),
      content: decodeContent(input.content),
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
    } as const);
  },
} as const;

export default webChannelAdapter;
