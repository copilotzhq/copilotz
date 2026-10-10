/** Server registration of the shared durable ingress definition. @module */
import { defineProcessor } from "@copilotz/copilotz/plugins";
import { serverActionRequestProcessor as ingressDefinition } from "@copilotz/copilotz/engine";
export const serverActionRequestProcessor: typeof ingressDefinition =
  defineProcessor(ingressDefinition);
export default serverActionRequestProcessor;
