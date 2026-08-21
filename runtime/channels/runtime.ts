import type { CopilotzApplication } from "../application/index.ts";
import { resolveChannelIdentity } from "./identity.ts";
import type {
  ChannelDispatchResult,
  ChannelExecution,
  ChannelIngressEnvelope,
  ChannelResource,
  ChannelRuntime,
  CreateChannelRuntimeOptions,
} from "./types.ts";

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

async function startExecution(
  application: CopilotzApplication,
  namespace: string,
  channel: ChannelResource,
  envelope: ChannelIngressEnvelope,
): Promise<ChannelExecution> {
  const identity = await resolveChannelIdentity(
    application,
    namespace,
    channel,
    envelope,
  );
  const handle = await application.send({
    ...envelope.input,
    namespace,
  });
  return Object.freeze({
    handle,
    thread: identity.thread,
    participant: identity.participant,
    recipientIds: identity.recipientIds,
    outputs: handle.outputs,
  });
}

/** Dispatches channel plugin resources over collections and attachments. */
export function createChannelRuntime(
  application: CopilotzApplication,
  options: CreateChannelRuntimeOptions = {},
): ChannelRuntime {
  const channels = Object.freeze(
    Object.values(application.plugins.context.channels ?? {}).filter(
      (value): value is ChannelResource =>
        !!value && typeof value === "object" && "id" in value,
    ),
  );
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  return Object.freeze({
    list: () => channels,
    get: (id) => byId.get(id),
    async dispatch(namespaceInput, request) {
      const namespace = requiredText(namespaceInput, "Channel namespace");
      const ingress = byId.get(request.route.ingress);
      if (!ingress?.ingress) {
        throw new Error(
          `Channel ingress '${request.route.ingress}' was not found.`,
        );
      }
      const egress = byId.get(request.route.egress);
      if (!egress?.egress) {
        throw new Error(
          `Channel egress '${request.route.egress}' was not found.`,
        );
      }
      const normalized = await ingress.ingress.handle(request, {
        application,
        namespace,
        channel: ingress,
      });
      const executions = await Promise.all(
        (normalized.inputs ?? []).map((input) =>
          startExecution(application, namespace, ingress, input)
        ),
      );
      const tasks = executions.map((execution) => {
        const settle = execution.handle.done;
        const deliver = egress.egress!.deliver({
          application,
          namespace,
          channel: egress,
          route: request.route,
          request,
          execution,
        });
        return Promise.all([settle, deliver]).then(() => undefined);
      });
      const done = Promise.all(tasks).then(() => undefined);
      if (!egress.egress.requestBound) {
        done.catch((error) => options.onDetachedError?.(error, request));
      }
      const result: ChannelDispatchResult = {
        status: normalized.status ?? 202,
        ...(normalized.response !== undefined
          ? { response: normalized.response }
          : {}),
        requestBound: egress.egress.requestBound === true,
        executions: Object.freeze(executions),
        done,
        async cancel(reason = "channel_cancelled") {
          await Promise.all(
            executions.map((execution) => execution.handle.cancel(reason)),
          );
        },
      };
      return Object.freeze(result);
    },
  });
}
