/** Server registration of the shared durable ingress definition. @module */
import { defineProcessor } from "@copilotz/copilotz/plugins";
import { serverCollectionMutationRequestProcessor as ingressDefinition } from "@copilotz/copilotz/engine";
export const serverCollectionMutationRequestProcessor:
  typeof ingressDefinition = defineProcessor(
    ingressDefinition,
  );
export default serverCollectionMutationRequestProcessor;
export type { ServerCollectionMutationRequest } from "@copilotz/copilotz/engine";
