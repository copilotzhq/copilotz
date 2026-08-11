import { type CopilotzPlugin, definePlugin } from "../plugins/index.ts";
import type {
  ChannelEgressContext,
  ChannelIngressEnvelope,
  ChannelRequest,
  ChannelResource,
  CreateWebChannelOptions,
  CreateWebChannelPluginOptions,
} from "./types.ts";

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
  return input as ChannelIngressEnvelope;
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
    manifest: {
      id: options.pluginId?.trim() || "@copilotz/channel-web",
      version: options.version?.trim() || "3.0.0",
      provides: { channels: [channel.id] },
    },
    resources: { channels: [channel] },
  });
}
