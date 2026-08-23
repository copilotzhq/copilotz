import {
  createMemoryAssetRepository,
  createPluginRegistry,
  defineLlmProviderResource,
  definePlugin,
  type LlmProviderResource,
} from "../../index.ts";

export type RuntimeNeutralSmokeResult = Readonly<{
  assetId: string;
  assetText: string;
  pluginId: string;
  providerEndpoint: string;
  webStreams: true;
}>;

/**
 * Small operational contract that uses only Web APIs and injected resources.
 * The same bundled function runs under Node, Bun, browsers, and edge isolates.
 */
export async function runRuntimeNeutralSmoke(): Promise<
  RuntimeNeutralSmokeResult
> {
  const assets = createMemoryAssetRepository({
    createId: () => "runtime-smoke-asset",
  });
  const published = await assets.publish({
    namespace: "runtime-smoke",
    mediaType: "text/plain;charset=utf-8",
    body: new TextEncoder().encode("portable"),
    idempotencyKey: "runtime-smoke-body",
  });
  const body = await assets.open("runtime-smoke", published.id);
  if (!(body instanceof ReadableStream)) {
    throw new TypeError(
      "Asset repository did not return a Web ReadableStream.",
    );
  }
  const assetText = await new Response(body).text();

  const providerEndpoint = "https://runtime-smoke.invalid/v1/chat";
  const provider = defineLlmProviderResource({
    id: "runtime-smoke",
    type: "llm",
    generate: () => {
      throw new Error("runtime-smoke generate is not invoked");
    },
  });
  const plugin = definePlugin({
    id: "@copilotz/runtime-smoke",
    version: "3.0.0",
    adapters: { llm: { runtimeSmoke: provider } },
  });
  const registry = await createPluginRegistry({ plugins: [plugin] });
  const resolved: LlmProviderResource = registry.adapters.llm.runtimeSmoke;
  if (typeof resolved.generate !== "function") {
    throw new TypeError(
      "Runtime-smoke llm resource must implement generate().",
    );
  }

  return Object.freeze({
    assetId: published.id,
    assetText,
    pluginId: plugin.id,
    providerEndpoint,
    webStreams: true,
  });
}
