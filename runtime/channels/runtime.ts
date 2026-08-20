import type { CopilotzApplication } from "../application/index.ts";
import type {
  AttachmentSendInput,
  ConnectAttachmentInput,
} from "../attachments/index.ts";
import { resolveChannelIdentity } from "./identity.ts";
import type {
  ChannelDispatchResult,
  ChannelExecution,
  ChannelIngressEnvelope,
  ChannelRequest,
  ChannelResource,
  ChannelRuntime,
  CreateChannelRuntimeOptions,
} from "./types.ts";

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function isMessageInput(
  input: AttachmentSendInput,
): input is Extract<AttachmentSendInput, { content: unknown }> {
  return "content" in input;
}

function sendInput(
  input: AttachmentSendInput,
  recipientIds: readonly string[],
): AttachmentSendInput {
  if (isMessageInput(input)) return { ...input, recipientIds };
  return { ...input, recipientIds };
}

function queryText(
  query: ChannelRequest["query"],
  name: string,
): string | undefined {
  const value = query?.[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string" && item.trim());
    return typeof first === "string" ? first.trim() : undefined;
  }
}

function headerText(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized && value.trim()) return value.trim();
  }
}

function parseStreamOffsets(
  raw: string | undefined,
): ConnectAttachmentInput["streamOffsets"] {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError("Channel streamOffsets must be a JSON object.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Channel streamOffsets must be a JSON object.");
  }
  const next: Record<string, number> = {};
  for (
    const [key, value] of Object.entries(parsed as Record<string, unknown>)
  ) {
    const id = key.trim();
    if (!id) continue;
    const offset = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(
        `Channel stream offset for '${id}' must be a non-negative integer.`,
      );
    }
    next[id] = offset;
  }
  return Object.freeze(next);
}

function reconnectInput(
  request: ChannelRequest,
): Pick<ConnectAttachmentInput, "afterPosition" | "streamOffsets"> {
  const afterPosition = queryText(request.query, "afterPosition") ??
    headerText(request.headers, "last-event-id");
  const streamOffsets = parseStreamOffsets(
    queryText(request.query, "streamOffsets") ??
      headerText(request.headers, "x-copilotz-stream-offsets"),
  );
  return {
    ...(afterPosition ? { afterPosition } : {}),
    ...(streamOffsets && Object.keys(streamOffsets).length > 0
      ? { streamOffsets }
      : {}),
  };
}

async function startExecution(
  application: CopilotzApplication,
  namespace: string,
  channel: ChannelResource,
  envelope: ChannelIngressEnvelope,
  request: ChannelRequest,
): Promise<ChannelExecution> {
  const identity = await resolveChannelIdentity(
    application,
    namespace,
    channel,
    envelope,
  );
  const attachment = await application.connect({
    namespace,
    thread: identity.thread,
    participant: identity.participant,
    recipientIds: identity.recipientIds,
    ...reconnectInput(request),
  });
  try {
    const handle = await attachment.send(
      sendInput(envelope.input, identity.recipientIds) as never,
    );
    return Object.freeze({
      attachment,
      handle,
      thread: identity.thread,
      participant: identity.participant,
      recipientIds: identity.recipientIds,
      outputs: attachment.outputs,
    });
  } catch (error) {
    await attachment.close("channel_send_failed").catch(() => undefined);
    throw error;
  }
}

/** Dispatches channel plugin resources over collections and attachments. */
export function createChannelRuntime(
  application: CopilotzApplication,
  options: CreateChannelRuntimeOptions = {},
): ChannelRuntime {
  const channels = application.plugins.list<ChannelResource>("channels");
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
          startExecution(application, namespace, ingress, input, request)
        ),
      );
      const tasks = executions.map((execution) => {
        const settle = execution.handle.done.finally(() =>
          execution.attachment.close("channel_execution_settled")
        );
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
