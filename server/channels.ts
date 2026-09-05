/** Channel ingress over the single compiled HTTP boundary. */
import { channelIngress } from "../plugins/channel-core/authoring/channel-ingress/index.ts";
import { defineChannelResource } from "../plugins/channel-core/authoring/channel-resource/index.ts";
import type {
  ChannelAcceptResult,
  ChannelAdapter,
  ChannelIngressOccurrence,
  ChannelRequest,
} from "../plugins/channel-core/internal/contracts.ts";
import type {
  ApplicationSendHandle,
  ApplicationSendInput,
  InternalCopilotzApplication as CopilotzApplication,
} from "../runtime/application/types.ts";
import type { HttpError, HttpRequest, HttpResponse } from "./http-types.ts";
function appError(
  status: number,
  code: string,
  message: string,
): HttpError {
  return Object.assign(new Error(message), { status, code });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export async function handleChannel(
  application: CopilotzApplication,
  namespace: string,
  request: HttpRequest,
  path: readonly string[],
): Promise<HttpResponse> {
  const channelId = path.length === 1 ? path[0]?.trim() : "";
  if (!channelId) {
    throw appError(404, "route_not_found", "Channel route was not found.");
  }
  const candidate = application.plugins.resources.channels?.[channelId];
  if (!candidate) {
    throw appError(
      404,
      "channel_not_found",
      `Channel '${channelId}' was not found.`,
    );
  }
  const channel = defineChannelResource(candidate as never);
  const adapter = application.plugins.adapters.channels?.[channelId] as
    | ChannelAdapter
    | undefined;
  if (!adapter || typeof adapter.accept !== "function") {
    throw appError(
      404,
      "channel_not_found",
      `Channel Adapter '${channelId}' was not found.`,
    );
  }
  if (
    channel.egress === "request-observation" &&
    !request.headers?.["idempotency-key"]?.trim()
  ) {
    throw appError(
      400,
      "idempotency_key_required",
      "Idempotency-Key is required.",
    );
  }
  const rawBody = request.context?.rawBody;
  const channelRequest: ChannelRequest = Object.freeze({
    method: request.method,
    headers: Object.freeze({ ...(request.headers ?? {}) }),
    ...(request.query ? { query: request.query } : {}),
    body: request.body,
    ...(rawBody instanceof Uint8Array ? { rawBody: rawBody.slice() } : {}),
    ...(request.context ? { context: request.context } : {}),
  });
  const abort = new AbortController();
  let accepted: ChannelAcceptResult;
  try {
    accepted = acceptedChannels(
      await adapter.accept(channelRequest, {
        namespace,
        channelId,
        channel,
        signal: abort.signal,
        now: () => new Date(),
      }),
    );
  } catch (error) {
    abort.abort(error);
    throw error;
  }
  if ((accepted.status ?? 200) >= 400 && accepted.occurrences.length > 0) {
    abort.abort("channel_accept_rejected_occurrences");
    throw appError(
      500,
      "invalid_channel_accept",
      "A rejected Channel request cannot contain accepted occurrences.",
    );
  }
  let envelopes: ApplicationSendInput[];
  try {
    const operationMetadata = record(request.context?.operationMetadata);
    envelopes = accepted.occurrences.map((occurrence) => {
      const envelope = channelIngress(channelId, occurrence, {
        namespace,
        databaseSchema: application.config.databaseSchema,
      });
      return Object.freeze({
        ...envelope,
        ...(Object.keys(operationMetadata).length
          ? { operationMetadata: structuredClone(operationMetadata) }
          : {}),
      });
    });
  } catch (error) {
    abort.abort(error);
    throw error;
  }
  if (channel.egress === "request-observation" && envelopes.length > 1) {
    abort.abort("channel_request_has_multiple_occurrences");
    throw appError(
      400,
      "multiple_request_occurrences",
      "A request-observation Channel must accept exactly one occurrence.",
    );
  }
  const handles: ApplicationSendHandle[] = [];
  try {
    for (const envelope of envelopes) {
      handles.push(
        await application.send(envelope).catch((error) => {
          if (error?.code === "event_deduplication_conflict") {
            throw appError(
              409,
              "idempotency_conflict",
              "Idempotency key was reused with different input.",
            );
          }
          throw error;
        }),
      );
    }
  } catch (error) {
    abort.abort(error);
    await Promise.allSettled(
      handles.map((handle) => handle.cancel("channel_accept_failed")),
    );
    throw error;
  }
  if (channel.egress === "request-observation" && handles.length > 0) {
    const handle = handles[0];
    const status = await application.operationStatus({
      operationId: handle.operationId,
      namespace,
      databaseSchema: application.config.databaseSchema,
    });
    await handle.detach("http_receipt_returned");
    abort.abort("channel_accept_completed");
    const threadId = typeof status?.metadata.threadId === "string"
      ? status.metadata.threadId.trim()
      : "";
    const externalId = typeof status?.metadata.threadExternalId === "string"
      ? status.metadata.threadExternalId.trim()
      : typeof status?.metadata.externalThreadId === "string"
      ? status.metadata.externalThreadId.trim()
      : threadId;
    return {
      status: 202,
      data: Object.freeze({
        operationId: handle.operationId,
        status: status?.state === "accepted" ? "accepted" : "running",
        correlationId: handle.correlationId,
        checkpoint: handle.replayCursor,
        acceptedAt: status?.acceptedAt ?? new Date().toISOString(),
        ...(threadId
          ? { thread: Object.freeze({ id: threadId, externalId }) }
          : {}),
      }),
    };
  }
  for (const handle of handles) void handle.done.catch(() => undefined);
  await Promise.all(
    handles.map((handle) => handle.detach("provider_acknowledged")),
  );
  abort.abort("channel_accept_completed");
  const status = accepted.status ?? (handles.length ? 202 : 200);
  const response = accepted.response ??
    { accepted: true, occurrences: handles.length };
  return {
    status,
    data: typeof response === "string"
      ? new Response(response, {
        status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
      : Response.json(response, { status }),
  };
}

const ACCEPT_KEYS = new Set(["occurrences", "status", "response"]);

function acceptedChannels(value: unknown): ChannelAcceptResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Channel accept result must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Channel accept result must be a plain object.");
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !ACCEPT_KEYS.has(key)) {
      throw new TypeError(
        `Channel accept result cannot declare '${String(key)}'.`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(
        `Channel accept result.${key} must be a data property.`,
      );
    }
    if (descriptor.value === undefined) {
      throw new TypeError(`Channel accept result.${key} cannot be undefined.`);
    }
    snapshot[key] = descriptor.value;
  }
  const occurrences = snapshot.occurrences;
  if (
    !Array.isArray(occurrences) ||
    Object.getPrototypeOf(occurrences) !== Array.prototype ||
    Object.keys(occurrences).length !== occurrences.length ||
    Reflect.ownKeys(occurrences).some((key) =>
      key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= occurrences.length)
    )
  ) {
    throw new TypeError("Channel accept occurrences must be a dense array.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(occurrences);
  const normalized = Object.freeze(Array.from(
    { length: occurrences.length },
    (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(
          `Channel accept occurrences[${index}] must be a data property.`,
        );
      }
      const occurrence = descriptor.value;
      if (!occurrence || typeof occurrence !== "object") {
        throw new TypeError("Channel occurrence must be a plain object.");
      }
      return occurrence as ChannelIngressOccurrence;
    },
  ));
  const status = snapshot.status;
  if (
    status !== undefined &&
    (!Number.isSafeInteger(status) || Number(status) < 100 ||
      Number(status) > 599)
  ) throw new TypeError("Channel accept status must be an HTTP status.");
  return Object.freeze({
    occurrences: normalized,
    ...(status !== undefined ? { status: Number(status) } : {}),
    ...(snapshot.response !== undefined ? { response: snapshot.response } : {}),
  });
}
