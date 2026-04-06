/**
 * Web channel handler.
 *
 * Accepts a {@link MessagePayload} and returns an async iterable of typed
 * events. The caller decides the transport: SSE, WebSocket, long-polling, etc.
 *
 * @module
 *
 * @example
 * ```ts
 * import { webChannel } from "copilotz/server/channels/web";
 *
 * // Framework-agnostic — wire to your SSE / WS layer:
 * const res = await webChannel(req, copilotz);
 * for await (const { event, data } of res.events!) {
 *   sse.send(data, { event });
 * }
 * ```
 */

import type { Copilotz } from "@/index.ts";
import type { MessagePayload } from "@/database/schemas/index.ts";
import type { StreamEvent } from "@/runtime/index.ts";
import type { ChannelRequest, ChannelResponse } from "./types.ts";

const EVENT_MAP: Record<string, string> = {
  NEW_MESSAGE: "MESSAGE",
  ASSET_CREATED: "ASSET_CREATED",
  ASSET_ERROR: "ASSET_ERROR",
  TOKEN: "TOKEN",
  TOOL_CALL: "TOOL_CALL",
  ACTION: "ACTION",
};

export async function webChannel(
  request: ChannelRequest,
  copilotz: Copilotz,
): Promise<ChannelResponse> {
  if (request.method === "GET") {
    return { status: 200, body: "ok" };
  }

  const payload = request.body as MessagePayload;
  const controller = await copilotz.run(payload);

  async function* generateEvents() {
    for await (const event of controller.events as AsyncIterable<StreamEvent>) {
      const eventName = EVENT_MAP[event.type];
      if (eventName) {
        yield { event: eventName, data: event };
      }
    }
  }

  return { status: 200, body: { status: "ok" }, events: generateEvents() };
}
