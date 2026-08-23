import { base64ToBytes, parseDataUrl } from "@copilotz/copilotz/content";
import { definePlugin } from "@copilotz/copilotz/plugins";
import { channelsPlugin } from "./plugin.ts";
import { cloneChannelJson } from "./input.ts";
import { defineChannelResource } from "./resource.ts";
import type {
  ChannelAdapter,
  ChannelIngressOccurrence,
  ChannelJsonObject,
  ChannelMessageVisibility,
  ChannelParticipantInput,
  ChannelParticipantRef,
  ChannelProviderPlugin,
  ChannelResource,
  ChannelThreadInput,
} from "./types.ts";

const MEDIA_TYPES = new Set(["image", "audio", "video", "file"]);
const VISIBILITIES = new Set<ChannelMessageVisibility>([
  "public",
  "participants",
  "internal",
]);

export type CreateWebChannelResourceOptions = Readonly<{
  defaultAgentAliases?: readonly string[];
  metadata?: ChannelJsonObject;
}>;

export type CreateWebChannelPluginOptions =
  & CreateWebChannelResourceOptions
  & Readonly<{
    channelId?: string;
    pluginId?: string;
    version?: string;
  }>;

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

/** Data-only request-observation policy; its map alias is supplied by composition. */
export function createWebChannelResource(
  options: CreateWebChannelResourceOptions = {},
): ChannelResource {
  return defineChannelResource({
    egress: "request-observation",
    ...(options.defaultAgentAliases
      ? { defaultAgentAliases: options.defaultAgentAliases }
      : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}

/** Converts one typed Web body into a durable occurrence and worker semantics. */
export function createWebChannelAdapter(): ChannelAdapter {
  return Object.freeze({
    accept(request) {
      const body = record(request.body, "Web Channel request body");
      const occurrence: ChannelIngressOccurrence = Object.freeze({
        id: required(body.id, "Web Channel occurrence ID"),
        input: cloneChannelJson(body.input, "Web Channel input"),
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
          ? { thread: input.thread as ChannelThreadInput }
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

export function createWebChannelPlugin(
  options: CreateWebChannelPluginOptions = {},
): ChannelProviderPlugin {
  const channelId = options.channelId?.trim() || "web";
  return definePlugin({
    id: options.pluginId?.trim() || "@copilotz/channel-web",
    version: options.version?.trim() || "4.0.0",
    plugins: [channelsPlugin] as const,
    resources: {
      channels: { [channelId]: createWebChannelResource(options) },
    },
    adapters: { channels: { [channelId]: createWebChannelAdapter() } },
  });
}
