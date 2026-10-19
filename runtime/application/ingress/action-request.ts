/** Admits the requested Action directly through the ordinary Action caller. */
import { defineProcessor, type Processor } from "../../plugins/index.ts";
import { resolveActionSourceData } from "../../actions/protected-context.ts";
import { isSettledActionError } from "../../actions/invoker.ts";
import {
  parseServerActionRequest,
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  serverActionInvocationMetadata,
} from "./contracts.ts";

export const serverActionRequestProcessor: Processor = defineProcessor({
  id: "copilotz.server.action-request",
  on: [{ eventType: SERVER_ACTION_REQUEST_EVENT_TYPE }],
  async handle(event, context) {
    if (!event.durable) {
      throw new TypeError("Server Action requests must be durable Events.");
    }
    const request = parseServerActionRequest(
      await resolveActionSourceData(context),
    );
    const target = context.actions[request.actionAlias] as (
      input: unknown,
      options: import("../../actions/types.ts").ActionCallOptions,
    ) => Promise<unknown>;
    if (!target) {
      throw new TypeError(`Unknown Action '${request.actionAlias}'.`);
    }
    try {
      await target(request.input, {
        operationKey: `server:${request.requestId}:invoke`,
        identity: context.identity,
        signal: context.signal,
        metadata: serverActionInvocationMetadata(request),
      });
    } catch (error) {
      // The Action terminal owns semantic failure. Infrastructure failures
      // still retry the durable admission under its original identity.
      if (!isSettledActionError(error)) throw error;
    }
  },
});
export default serverActionRequestProcessor;
