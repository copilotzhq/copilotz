import type { CoreServicesRef } from "./services.ts";
import { createCoreProcessors } from "./processors.ts";
import { type CopilotzPlugin, definePlugin } from "@/plugins/types.ts";
import ask from "@/resources/tools/ask/index.ts";
import createThread from "@/resources/tools/create_thread/index.ts";
import * as collections from "@/resources/collections/mod.ts";
import * as llm from "@/resources/llm/mod.ts";
import type { ProviderFactory } from "@/runtime/llm/types.ts";
import type { MemoryResource, ProviderResource } from "@/types/resources.ts";

const historyMemory: MemoryResource = Object.freeze({
  resourceType: "memory",
  id: "history",
  name: "History",
  kind: "history",
  description: "Public thread history visible to the active agent.",
  enabled: true,
});

function textProvider(id: string, create: ProviderFactory): ProviderResource {
  return { resourceType: "providers", kind: "text", id, create };
}

export function createCorePlugin(ref: CoreServicesRef): CopilotzPlugin {
  const collectionResources = Object.values(collections);
  const providerResources = Object.entries(llm).map(([id, create]) =>
    textProvider(id, create)
  );
  const processors = createCoreProcessors(ref);
  return definePlugin({
    manifest: {
      id: "@copilotz/core",
      version: "2.0.0",
      provides: {
        tools: [ask.id, createThread.id],
        processors: processors.map((processor) => processor.id),
        collections: collectionResources.map((collection) => collection.name),
        providers: providerResources.map((provider) => provider.id),
        memory: [historyMemory.id],
      },
      presets: {
        core: ["tools", "processors", "collections", "providers", "memory"],
      },
    },
    resources: {
      tools: [ask, createThread],
      processors,
      collections: collectionResources,
      providers: providerResources,
      memory: [historyMemory],
    },
  });
}
