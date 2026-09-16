import type { Processor } from "@copilotz/copilotz/plugins";
/** Owns durable Server Action request orchestration. @module */

import type { ActionCaller } from "@copilotz/copilotz/actions";
import {
  defineProcessor,
  type ProcessorContext,
} from "@copilotz/copilotz/plugins";
import type { serverInvokeAction } from "../../actions/invoke-action/index.ts";
import {
  parseServerActionRequest,
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  type ServerInvokeRequest,
} from "../../internal/contracts.ts";

type ServerProcessorContext = ProcessorContext<
  import("@copilotz/copilotz/actions").RuntimeContextNamespaces,
  import("@copilotz/copilotz/actions").RuntimeContextNamespaces,
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
