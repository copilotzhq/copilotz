import { createMemoryAssetRepository } from "@copilotz/copilotz/content";
import { createPluginRegistry, definePlugin } from "@copilotz/copilotz/plugins";
import {
  defineModel,
  type LlmAdapter,
  type ModelResource,
} from "@copilotz/copilotz/llm";

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
  const adapter: LlmAdapter = Object.freeze({
    call: () => ({
      frames: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      result: Promise.resolve({
        content: "runtime-smoke is not invoked",
        attempts: [{ status: "completed" as const }],
      }),
    }),
  });
  const model = defineModel({
    adapter: "runtimeSmoke",
    model: "runtime-smoke-model",
  });
  const plugin = definePlugin({
    id: "@copilotz/runtime-smoke",
    version: "3.0.0",
    resources: { models: { runtimeSmoke: model } },
    adapters: { llm: { runtimeSmoke: adapter } },
  });
  const registry = await createPluginRegistry({ plugins: [plugin] });
  const resolvedAdapter: LlmAdapter = registry.adapters.llm.runtimeSmoke;
  const resolvedModel: ModelResource = registry.resources.models.runtimeSmoke;
  if (
    typeof resolvedAdapter.call !== "function" ||
    !("adapter" in resolvedModel) ||
    resolvedModel.adapter !== "runtimeSmoke"
  ) {
    throw new TypeError(
      "Runtime-smoke LLM composition must include its Model and Adapter.",
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
