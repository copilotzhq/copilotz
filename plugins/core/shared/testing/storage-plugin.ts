/** Explicit primitive subset for runtime tests that do not run conversation processors. */
import {
  coreActions,
  coreCollections,
  coreProcessors,
} from "@copilotz/copilotz/core";
import { definePlugin } from "@copilotz/copilotz/plugins";
const { compactContext: _compactContext, ...actions } = coreActions;
export const storageFixture = definePlugin({
  id: "test.storage",
  version: "1",
  collections: coreCollections,
  actions,
  processors: { messageInput: coreProcessors.messageInput },
});
