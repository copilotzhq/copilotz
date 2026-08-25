/** Composes the semantic Server Resource and durable Action bridge. @module */

import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import { serverInvokeAction } from "./actions/index.ts";
import { serverActionRequestProcessor } from "./processors/index.ts";
import { defineServerFacade } from "./resources/facade/index.ts";
import type { DefineServerFacadeInput } from "./internal/contracts.ts";

/** Creates one Server facade plugin declaration. */
export function createServerPlugin(
  options: DefineServerFacadeInput = {},
): CopilotzPlugin {
  const facade = defineServerFacade(options);
  return definePlugin({
    id: "copilotz.server",
    version: "1.0.0",
    actions: { serverInvoke: serverInvokeAction },
    processors: { serverActionRequest: serverActionRequestProcessor },
    resources: { server: { default: facade } },
  });
}

/** Default allow-all facade for tests and single-tenant applications. */
export const serverPlugin: CopilotzPlugin = createServerPlugin();
