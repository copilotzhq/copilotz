import { assert, assertEquals } from "@std/assert";
import { corePlugin, defineAgent } from "@copilotz/copilotz/core";
import {
  createPluginRegistry,
  definePlugin,
} from "../../../../runtime/plugins/index.ts";
import { createCopilotzEngine } from "../../../../runtime/engine/index.ts";
import { createSqlSession } from "../../../../runtime/events/index.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
Deno.test("Core sends stable isolated subscription sessions through the built-in provider", async () => {
  const namespace = "routing-tenant";
  const captured: {
    key: string;
    headers: Headers;
  }[] = [];
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => release = resolve);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assertEquals(
      String(input),
      "https://chatgpt.com/backend-api/codex/responses",
    );
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body));
    assert(typeof body.prompt_cache_key === "string");
    assertEquals(headers.get("session-id"), body.prompt_cache_key);
    assertEquals(headers.get("thread-id"), body.prompt_cache_key);
    assertEquals(headers.get("x-client-request-id"), body.prompt_cache_key);
    assertEquals(headers.get("x-codex-routing-hint"), "model=gpt-6-astra");
    assertEquals(headers.get("x-codex-turn-state"), null);
    assert(!body.prompt_cache_key.includes(namespace));
    captured.push({ key: body.prompt_cache_key, headers });
    if (captured.length === 2) {
      release();
    }
    if (captured.length <= 2) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          bothStarted,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Agent requests did not overlap")),
              3000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    const events = [
      { type: "response.output_text.delta", delta: "OK" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 20,
            output_tokens: 1,
            total_tokens: 21,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      {
        headers: {
          "content-type": "text/event-stream",
          "x-codex-turn-state": "must-not-be-replayed",
        },
      },
    );
  };
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let engine: Awaited<ReturnType<typeof createCopilotzEngine>> | undefined;
  try {
    db = await createTestDatabase({ url: ":memory:" });
    const agents = Object.fromEntries(["north", "south"].map((id) => [
      id,
      defineAgent({
        id,
        name: id,
        role: "assistant",
        instructions: "Reply OK.",
        models: {
          generate: [{ connection: "subscription", model: "gpt-6-astra" }],
        },
      }),
    ]));
    const registry = await createPluginRegistry({
      plugins: [
        corePlugin,
        definePlugin({
          id: "test.subscription-routing",
          version: "1.0.0",
          resources: {
            agents,
            llmConnections: {
              subscription: {
                provider: "openai",
                baseUrl: "https://chatgpt.com/backend-api/codex",
                auth: {
                  apiKey: "test-bearer",
                  extraHeaders: { "ChatGPT-Account-ID": "test-account" },
                },
              },
            },
          },
        }),
      ],
    });
    engine = await createCopilotzEngine({
      session: createSqlSession(db),
      registry,
      defaultDatabaseSchema: "subscription_routing",
      execution: { capacity: 4 },
      retryBaseMs: 0,
      random: () => 0,
    });
    if (!engine) {
      throw new Error("Failed to create subscription-routing engine.");
    }
    const participant = engine.collections.get("participant")!;
    await participant.create({ namespace }, {
      id: "human",
      externalId: "human",
      participantType: "human",
    }, {});
    for (const id of ["north", "south"]) {
      await participant.create({ namespace }, {
        id,
        externalId: id,
        participantType: "agent",
        agentId: id,
        name: id,
      }, {});
    }
    await engine.collections.get("thread")!.create({ namespace }, {
      id: "thread",
      participantIds: ["human", "north", "south"],
    }, {});
    for (const turn of [1, 2]) {
      const id = `user-${turn}`;
      const content = await engine.content.preparer.prepare("Reply OK.", {
        namespace,
        idempotencyKey: id,
      });
      await engine.collections.get("message")!.create({ namespace }, {
        id,
        threadId: "thread",
        senderId: "human",
        recipientIds: ["north", "south"],
        content,
        metadata: {},
      }, {
        identity: { deduplicationId: id },
        metadata: {
          core: {
            threadId: "thread",
            routing: { senderId: "human", recipientIds: ["north", "south"] },
          },
        },
      });
      const event = (await engine.events.list({ namespace, limit: 1000 })).find(
        (item) => item.type === "message.created" && item.subject?.id === id,
      );
      assert(event);
      const deadline = Date.now() + 15000;
      while (true) {
        const settlement = await engine.events.settlement(namespace, event.id);
        assertEquals(settlement.deadLetters, 0);
        if (!settlement.unsettled) {
          break;
        }
        assert(Date.now() < deadline, "Conversation did not settle");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assertEquals(captured.length, turn * 2);
    }
    assertEquals(new Set(captured.slice(0, 2).map((item) => item.key)).size, 2);
    assertEquals(
      captured.slice(0, 2).map((item) => item.key).sort(),
      captured.slice(2).map((item) => item.key).sort(),
    );
  } finally {
    try {
      await engine?.shutdown();
    } finally {
      try {
        await db?.close();
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  }
});
