/** Server registration of the shared durable ingress definition. @module */
import { defineAction } from "@copilotz/copilotz/actions";
import { serverInvokeAction as ingressDefinition } from "@copilotz/copilotz/engine";
export const serverInvokeAction: typeof ingressDefinition = defineAction(
  ingressDefinition,
);
export default serverInvokeAction;
export { SERVER_INVOKE_ACTION_ID } from "@copilotz/copilotz/engine";
export type { ServerInvokeActionOutput } from "@copilotz/copilotz/engine";
