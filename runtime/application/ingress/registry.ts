/** Installs generic ingress even when the optional HTTP facade is absent. @module */
import {
  createPluginRegistry,
  type PluginRegistry,
} from "../../plugins/index.ts";
import { serverInvokeAction } from "./invoke-action.ts";
import { serverActionRequestProcessor } from "./action-request.ts";
import { serverCollectionMutationRequestProcessor } from "./collection-mutation-request.ts";

export function withApplicationIngress(
  registry: PluginRegistry,
): PluginRegistry {
  const actions = { serverInvoke: serverInvokeAction };
  const processors = {
    serverActionRequest: serverActionRequestProcessor,
    serverCollectionMutationRequest: serverCollectionMutationRequestProcessor,
  };
  // Server declarations register these same definitions. Keep their existing
  // registration and durable consumer IDs instead of installing a second path.
  for (const [kind, defaults] of Object.entries({ actions, processors })) {
    const registered = registry[kind as "actions" | "processors"];
    for (const [alias, definition] of Object.entries(defaults)) {
      if (registered[alias] && registered[alias].id !== definition.id) {
        throw new TypeError(
          `Application ingress alias '${alias}' is reserved.`,
        );
      }
    }
  }
  const ingress = createPluginRegistry({
    actions: Object.fromEntries(
      Object.entries(actions).filter(([alias]) => !registry.actions[alias]),
    ),
    processors: Object.fromEntries(
      Object.entries(processors).filter(([alias]) =>
        !registry.processors[alias]
      ),
    ),
  });
  return {
    ...registry,
    actions: { ...ingress.actions, ...registry.actions },
    processors: { ...ingress.processors, ...registry.processors },
    matchDurable: (
      draft,
      data,
    ) => [
      ...registry.matchDurable(draft, data),
      ...ingress.matchDurable(draft, data),
    ],
    durableConsumers: (
      draft,
      data,
    ) => [
      ...registry.durableConsumers(draft, data),
      ...ingress.durableConsumers(draft, data),
    ],
    processorForConsumer: (id) =>
      registry.processorForConsumer(id) ?? ingress.processorForConsumer(id),
  };
}
