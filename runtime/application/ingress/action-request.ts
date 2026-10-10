import type { Processor } from "../../plugins/index.ts";
/** Owns durable Server Action request orchestration. @module */

import type { ActionCaller } from "../../actions/index.ts";
import { defineProcessor, type ProcessorContext } from "../../plugins/index.ts";
import type { serverInvokeAction } from "./invoke-action.ts";
import {
  parseServerActionRequest,
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  type ServerInvokeRequest,
} from "./contracts.ts";

type ServerProcessorContext = ProcessorContext<
  import("../../actions/index.ts").RuntimeContextNamespaces,
  import("../../actions/index.ts").RuntimeContextNamespaces,
  Readonly<{ serverInvoke: ActionCaller<typeof serverInvokeAction> }>
>;

export const serverActionRequestProcessor: Processor<ServerProcessorContext> =
  defineProcessor<
    ServerProcessorContext
  >({
    id: "copilotz.server.action-request",
    on: [{ eventType: SERVER_ACTION_REQUEST_EVENT_TYPE }],
    async handle(event, context) {
      if (!event.durable) {
        throw new TypeError("Server Action requests must be durable Events.");
      }
      const input = parseServerActionRequest(event.data);
      const invoke: ServerInvokeRequest = {
        requestId: input.requestId,
        actionAlias: input.actionAlias,
      } as const;
      await context.actions.serverInvoke(invoke, {
        operationKey: `server:${input.requestId}:invoke`,
        identity: context.identity,
        signal: context.signal,
      });
    },
  });

export default serverActionRequestProcessor;
