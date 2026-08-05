import {
  createMemoryAssetStore,
  definePlugin,
  defineProcessor,
  PluginRegistry,
  type RealtimeProviderResource,
} from "../index.ts";

export async function runRuntimeSmoke(): Promise<{
  plugin: string;
  processor: string;
  bytes: number[];
}> {
  const processor = defineProcessor({
    id: "smoke.processor",
    on: ["smoke.created"],
    delivery: "durable",
    handle: () => undefined,
  });
  const provider: RealtimeProviderResource = {
    resourceType: "providers",
    kind: "realtime",
    id: "smoke.realtime",
    async *run(input) {
      for await (const _chunk of input.payload) {
        // Consume with Web Streams in every target runtime.
      }
      yield* [];
    },
  };
  const plugin = definePlugin({
    manifest: {
      id: "smoke.plugin",
      version: "1.0.0",
      provides: {
        processors: [processor.id],
        providers: [provider.id],
      },
    },
    resources: { processors: [processor], providers: [provider] },
  });
  const override = defineProcessor({
    ...processor,
    handle: () => undefined,
  });
  const registry = await PluginRegistry.compose({
    plugins: [plugin],
    resources: { processors: [override] },
  });

  const assets = createMemoryAssetStore();
  const saved = await assets.save(new Uint8Array([1, 2, 3]), "audio/pcm");
  const loaded = await assets.get(saved.assetId);
  const transformed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(loaded.bytes);
      controller.close();
    },
  }).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk.map((value) => value + 1));
      },
    }),
  );
  const bytes = [
    ...new Uint8Array(await new Response(transformed).arrayBuffer()),
  ];

  if (registry.require("processors", processor.id) !== override) {
    throw new Error("Plugin override precedence failed.");
  }
  if (registry.require("providers", provider.id).kind !== "realtime") {
    throw new Error("Injected realtime provider resolution failed.");
  }
  if (bytes.join(",") !== "2,3,4") throw new Error("Web Streams smoke failed.");
  return { plugin: plugin.manifest.id, processor: processor.id, bytes };
}
