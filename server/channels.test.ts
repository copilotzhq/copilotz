import { assertEquals, assertRejects } from "@std/assert";
import { createCopilotzApplication } from "../runtime/application/index.ts";
import {
  type ChannelAdapter,
  channelsPlugin,
  createWebChannelAdapter,
  createWebChannelResource,
} from "../plugins/channels/index.ts";
import {
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../runtime/plugins/index.ts";
import { corePlugin } from "../plugins/core/plugin.ts";
import type { AgentResource } from "@copilotz/copilotz/core";
import type { LlmAdapter, LlmAdapterResult } from "@copilotz/copilotz/llm";
import { createServerPlugin } from "../plugins/server/index.ts";
import { createServerFacadeFetchHandler } from "./facade.ts";
import { createCopilotzClient } from "../client/index.ts";
const NAMESPACE = "tenant-a";
const SCHEMA = "channel_http_contract";
const server = () =>
  createServerPlugin({ authenticate: () => ({ actor: { id: "user-a" } }) });
function client(
  application: Awaited<ReturnType<typeof createCopilotzApplication>>,
) {
  const handler = createServerFacadeFetchHandler(application);
  return createCopilotzClient({
    baseUrl: "https://test/api",
    fetch: ((url, init) => handler(new Request(url, init))) as typeof fetch,
  });
}
Deno.test("Channel receipts precede settlement and detaching observers does not cancel work", async () => {
  let release!: () => void;
  const settlement = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = definePlugin({
    id: "test.request-bound-channel-blocker",
    version: "1.0.0",
    processors: {
      wait: defineProcessor<ProcessorContext>({
        id: "test.request-bound-channel-wait",
        on: [{ eventType: "message.created" }],
        async handle(_event, _context) {
          await settlement;
        },
      }),
    },
  });
  let acceptSignal: AbortSignal | undefined;
  const web = createWebChannelAdapter();
  const observedWeb: ChannelAdapter = Object.freeze({
    ...web,
    accept(request, context) {
      acceptSignal = context.signal;
      return web.accept(request, context);
    },
  });
  const channelProvider = definePlugin({
    id: "test.request-bound-channel-provider",
    version: "1.0.0",
    plugins: [channelsPlugin] as const,
    resources: { channels: { web: createWebChannelResource() } },
    adapters: {
      channels: {
        web: observedWeb,
      },
    },
  });
  const application = await createCopilotzApplication({
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_request_bound`,
    plugins: [channelProvider, blocker, server()],
  });
  try {
    const browser = client(application);
    const receipt = await browser.channels.submit("web", {
      externalThreadId: "request-thread-a",
      content: "streamed",
    }, { idempotencyKey: "request-bound-a" });
    assertEquals(acceptSignal?.aborted, true);
    const abort = new AbortController();
    let observed = 0;
    await assertRejects(() =>
      browser.operations.observe({
        operationIds: [receipt.operationId],
        signal: abort.signal,
        onFrame() {
          observed++;
          abort.abort();
        },
      })
    );
    assertEquals(observed, 1);
    const status = await application.operationStatus({
      namespace: NAMESPACE,
      operationId: receipt.operationId,
    });
    assertEquals(status?.state === "cancelled", false);
    release();
    await browser.operations.result(receipt.operationId);
  } finally {
    release();
    await application.close();
  }
});
Deno.test("Channel receipt observation includes delayed Core model output before completion", async () => {
  let release!: () => void;
  const response = new Promise<LlmAdapterResult>((resolve) => {
    release = () =>
      resolve({
        content: { type: "text", text: "Hello from Support", role: "body" },
        attempts: [{
          status: "completed",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }],
        finishReason: "stop",
      });
  });
  let called!: () => void;
  const calledPromise = new Promise<void>((resolve) => called = resolve);
  const delayedAdapter: LlmAdapter = Object.freeze({
    call() {
      called();
      return Object.freeze({
        frames: new ReadableStream({
          async start(controller) {
            const result = await response;
            controller.enqueue({
              lane: "content",
              mediaType: "text/plain",
              bytes: new TextEncoder().encode(
                (result.content as { text: string }).text,
              ),
            });
            controller.close();
          },
        }),
        result: response,
      });
    },
  });
  const configuration = definePlugin({
    id: "test.request-observation-delayed-llm",
    version: "1.0.0",
    resources: {
      agents: {
        support: Object.freeze(
          {
            id: "support",
            name: "Support",
            role: "support",
            instructions: "Reply concisely.",
            models: { generate: ["delayed"] as const },
            capabilities: { tools: [] },
          } satisfies AgentResource,
        ),
      },
      models: { delayed: { adapter: "delayed", model: "delayed-model" } },
    },
    adapters: { llm: { delayed: delayedAdapter } },
  });
  const channelProvider = definePlugin({
    id: "test.request-observation-delayed-channel",
    version: "1.0.0",
    plugins: [channelsPlugin] as const,
    resources: {
      channels: {
        web: createWebChannelResource({ defaultAgentAliases: ["support"] }),
      },
    },
    adapters: { channels: { web: createWebChannelAdapter() } },
  });
  const application = await createCopilotzApplication({
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_delayed_llm`,
    plugins: [corePlugin, channelProvider, configuration, server()],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    const browser = client(application);
    const receipt = await browser.channels.submit("web", {
      externalThreadId: "delayed-thread",
      content: "Hello",
    }, { idempotencyKey: "delayed" });
    await calledPromise;
    const outputs: string[] = [];
    let text = "";
    let settled = false;
    const observing = browser.operations.observe({
      operationIds: [receipt.operationId],
      onFrame(frame) {
        if (frame.kind === "output") outputs.push(frame.output.type);
        if (frame.kind === "stream-chunk") {
          text += new TextDecoder().decode(frame.bytes);
        }
      },
    }).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(settled, false);
    release();
    await observing;
    assertEquals(text, "Hello from Support");
    assertEquals(outputs.includes("llm.call.completed"), true);
    assertEquals(
      outputs.filter((type) => type === "message.created").length,
      2,
    );
    assertEquals(outputs.at(-1), "operation.completed");
  } finally {
    release();
    await application.close();
  }
});
Deno.test("Channel host validates every occurrence before persistence and cleans up rejected accepts", async () => {
  const signals: AbortSignal[] = [];
  const adapter = (
    occurrences: readonly Readonly<Record<string, unknown>>[],
  ): ChannelAdapter =>
    Object.freeze({
      accept(_request, context) {
        signals.push(context.signal);
        return Object.freeze({
          occurrences: Object.freeze(occurrences),
        }) as never;
      },
      receive() {
        throw new Error("Rejected host accepts must not reach a worker.");
      },
    });
  const provider = definePlugin({
    id: "test.channel-host-prevalidation",
    version: "1.0.0",
    plugins: [channelsPlugin] as const,
    resources: {
      channels: {
        multiple: createWebChannelResource(),
        invalid: Object.freeze({ egress: "external" as const }),
      },
    },
    adapters: {
      channels: {
        multiple: adapter([
          Object.freeze({ id: "one", input: Object.freeze({}) }),
          Object.freeze({ id: "two", input: Object.freeze({}) }),
        ]),
        invalid: adapter([
          Object.freeze({
            id: "valid",
            input: Object.freeze({}),
          }),
          Object.freeze({
            id: "invalid",
            input: Object.freeze({}),
            legacyRoute: Object.freeze({}),
          }),
        ]),
      },
    },
  });
  const application = await createCopilotzApplication({
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_channel_host_prevalidation`,
    plugins: [provider, server()],
  });
  const handler = createServerFacadeFetchHandler(application);
  try {
    const post = (alias: string) =>
      handler(
        new Request(`https://test/api/channels/${alias}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": alias,
          },
          body: "{}",
        }),
      );
    assertEquals((await post("multiple")).status, 400);
    assertEquals((await post("invalid")).status, 500);
    assertEquals(signals.map((signal) => signal.aborted), [true, true]);
    assertEquals(
      (await application.events.list({ namespace: NAMESPACE })).filter((
        event,
      ) => event.type === "copilotz.channels.ingress.input"),
      [],
    );
  } finally {
    await application.close();
  }
});
