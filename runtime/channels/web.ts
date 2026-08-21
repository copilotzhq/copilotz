import { type CopilotzPlugin, definePlugin } from "../plugins/index.ts";
import { base64ToBytes, parseDataUrl } from "../content/index.ts";
import type {
  ChannelEgressContext,
  ChannelIngressEnvelope,
  ChannelRequest,
  ChannelResource,
  CreateWebChannelOptions,
  CreateWebChannelPluginOptions,
} from "./types.ts";

const MEDIA_TYPES = new Set(["image", "audio", "video", "file"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function contentPart(value: unknown): unknown {
  const part = record(value);
  if (!part || typeof part.type !== "string" || !MEDIA_TYPES.has(part.type)) {
    return value;
  }
  if (part.bytes instanceof Uint8Array) return value;
  const encoded = typeof part.dataBase64 === "string"
    ? {
      bytes: base64ToBytes(part.dataBase64),
      mediaType: typeof part.mediaType === "string"
        ? part.mediaType
        : "application/octet-stream",
    }
    : typeof part.url === "string"
    ? parseDataUrl(part.url)
    : null;
  if (!encoded) {
    throw new TypeError(
      `Web channel ${part.type} content requires dataBase64 or a data URL.`,
    );
  }
  const { dataBase64: _dataBase64, url: _url, ...rest } = part;
  return Object.freeze({
    ...rest,
    bytes: encoded.bytes,
    mediaType: typeof part.mediaType === "string"
      ? part.mediaType
      : encoded.mediaType,
  });
}

function webInput(value: unknown): unknown {
  const input = record(value);
  if (!input) return value;
  if ("payload" in input) {
    return Object.freeze({ ...input });
  }
  if (!("content" in input)) return value;
  const content = Array.isArray(input.content)
    ? Object.freeze(input.content.map(contentPart))
    : contentPart(input.content);
  return Object.freeze({ ...input, content });
}

function envelope(value: unknown): ChannelIngressEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Web channel body must be a channel ingress envelope.");
  }
  const input = value as Partial<ChannelIngressEnvelope>;
  if (!input.thread || !input.participant || !input.input) {
    throw new TypeError(
      "Web channel body requires thread, participant, and input.",
    );
  }
  return Object.freeze({
    ...input,
    input: webInput(input.input),
  }) as ChannelIngressEnvelope;
}

/** Creates the request-bound Web/SSE channel using unified attachment outputs. */
export function createWebChannel(
  options: CreateWebChannelOptions = {},
): ChannelResource {
  const id = options.id?.trim() || "web";
  return Object.freeze({
    id,
    ...(options.defaultAgentIds?.length
      ? { defaultAgentIds: Object.freeze([...options.defaultAgentIds]) }
      : {}),
    ingress: Object.freeze({
      handle(request: ChannelRequest) {
        return {
          status: 202,
          response: { accepted: true },
          inputs: Object.freeze([envelope(request.body)]),
        };
      },
    }),
    egress: Object.freeze({
      requestBound: true,
      async deliver(context: ChannelEgressContext) {
        if (!context.request.callback) {
          throw new TypeError(
            "Web channel egress requires an output callback.",
          );
        }
        for await (const output of context.execution.outputs) {
          await context.request.callback(output);
        }
      },
    }),
  });
}

export function createWebChannelPlugin(
  options: CreateWebChannelPluginOptions = {},
): CopilotzPlugin {
  const channel = createWebChannel(options);
  return definePlugin({
    id: options.pluginId?.trim() || "@copilotz/channel-web",
    version: options.version?.trim() || "3.0.0",
    channels: [channel],
  });
}
