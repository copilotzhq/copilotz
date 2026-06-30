/**
 * Long-term memory end-to-end example.
 *
 * Demonstrates the full checkpointed-graph memory lifecycle:
 *   1. Agent replies accumulate in the hot window.
 *   2. When the character threshold is crossed the trigger reserves a pending
 *      long_term_memory node (boundary committed before any LLM work).
 *   3. The bundled processor consolidates that range into memory items and
 *      finalizes the node as ready.
 *   4. The next LLM call sees the stored memory content in the system prompt
 *      instead of the archived message history.
 *
 * Run with mocked HTTP (no API key required):
 *   deno run -A examples/long-term-memory-e2e.ts
 *
 * Run with the real OpenAI API:
 *   deno run -A --env examples/long-term-memory-e2e.ts
 */

import { createCopilotz } from "../index.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function assertEquals<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}\n  expected: ${expected}\n  got:      ${actual}`);
  }
}

// ─── live mode detection ──────────────────────────────────────────────────────

const OPENAI_KEY = Deno.env.get("OPENAI_KEY") ||
  Deno.env.get("OPENAI_API_KEY") ||
  Deno.env.get("DEFAULT_OPENAI_KEY") || Deno.env.get("LLM_API_KEY");
const LIVE_MODE = Boolean(OPENAI_KEY);

if (LIVE_MODE) {
  console.log("Running in LIVE mode with real OpenAI API.");
} else {
  console.log(
    "Running in MOCK mode (no API key found). Pass --env to use real OpenAI.",
  );
}

const OPENAI_BASE = LIVE_MODE
  ? "https://api.openai.com"
  : "https://mock.openai.test";
const BASE = `${OPENAI_BASE}/v1`;
const CHAT_URL = `${BASE}/chat/completions`;
const EMBED_URL = `${BASE}/embeddings`;
const FAKE_VECTOR = Array<number>(1536).fill(0.01);

// ─── request tracking + fetch mock/interceptor ────────────────────────────────

let chatCallCount = 0;
const llmRequests: Array<Record<string, unknown>> = [];
const originalFetch = globalThis.fetch;

const isConsolidationBody = (body: Record<string, unknown>): boolean =>
  (body as { response_format?: { type?: string } }).response_format?.type ===
    "json_object";

if (LIVE_MODE) {
  // Pass-through: forward all requests to the real API but record chat bodies
  // so the turn-4 system-prompt assertion can still inspect them.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    if (url === CHAT_URL || url.includes("/chat/completions")) {
      try {
        const body = JSON.parse(
          (init?.body as string) ?? "{}",
        ) as Record<string, unknown>;
        llmRequests.push(body);
        if (!isConsolidationBody(body)) chatCallCount++;
      } catch { /* ignore */ }
    }
    return originalFetch(input, init);
  }) as typeof fetch;
} else {
  // Full mock: intercept every HTTP call and return deterministic responses.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;

    if (url === EMBED_URL) {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        input: unknown[];
      };
      const count = Array.isArray(body.input) ? body.input.length : 1;
      return Response.json({
        data: Array.from({ length: count }, (_v, i) => ({
          object: "embedding",
          index: i,
          embedding: FAKE_VECTOR,
        })),
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 10, total_tokens: 10 },
      });
    }

    if (url === CHAT_URL) {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<
        string,
        unknown
      >;
      llmRequests.push(body);

      // Consolidation call — detected by "consolidate_memory" in the user message.
      // The system prompt is identical to regular chat (cache-stable); only the
      // user message carries consolidation-specific content.
      if (isConsolidationBody(body)) {
        const proposal = {
          workState: "Discussing Copilotz long-term memory architecture.",
          items: [
            {
              localId: "item-1",
              kind: "decision",
              name: "Memory checkpoint design",
              content:
                "Copilotz uses single-assignment long_term_memory checkpoints for stable prompt prefixes.",
              confidence: 0.97,
              sourceMessageIds: [],
            },
            {
              localId: "item-2",
              kind: "fact",
              name: "Pending-to-ready transition",
              content:
                "A long_term_memory node is reserved as pending before any LLM work runs, ensuring idempotent retries.",
              confidence: 0.95,
              sourceMessageIds: [],
            },
          ],
          relations: [
            { source: "item-2", type: "supports", target: "item-1" },
          ],
        };
        // JSON output mode — return the proposal as raw JSON text via SSE.
        const proposalJson = JSON.stringify(proposal);
        const consolidationEvents = [
          {
            choices: [
              { delta: { content: proposalJson }, finish_reason: null },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 80,
              total_tokens: 200,
            },
          },
        ];
        const consolidationBody = consolidationEvents
          .map((e) => `data: ${JSON.stringify(e)}\n\n`)
          .join("") + "data: [DONE]\n\n";
        return new Response(consolidationBody, {
          headers: { "content-type": "text/event-stream" },
        });
      }

      // Normal streaming chat response.
      chatCallCount += 1;
      const content = `Chat reply ${chatCallCount}.`;
      const events = [
        { choices: [{ delta: { content }, finish_reason: null }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 5,
            total_tokens: 25,
          },
        },
      ];
      const body_ = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(
        "",
      ) + "data: [DONE]\n\n";
      return new Response(body_, {
        headers: { "content-type": "text/event-stream" },
      });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;
}

// ─── copilotz instance ────────────────────────────────────────────────────────

const copilotz = await createCopilotz({
  namespace: "example-long-term-memory",
  agentsFile: false,
  agents: [
    {
      id: "assistant",
      name: "Assistant",
      role: "assistant",
      instructions: "You are a concise assistant that remembers context.",
      llmOptions: {
        provider: "openai",
        model: "gpt-4o-mini",
        openaiApi: "chat_completions",
        estimateCost: false,
        // In mock mode: point at the local interceptor and disable network timeouts.
        ...(!LIVE_MODE && {
          baseUrl: BASE,
          firstTokenTimeoutMs: 0,
          streamIdleTimeoutMs: 0,
        }),
      },
    },
  ],
  memory: [
    {
      name: "long_term",
      kind: "long_term",
      enabled: true,
      config: {
        // Low threshold so a few messages trigger consolidation.
        triggerEstimatedTokens: 50,
        maxContentEstimatedTokens: 12_000,
        retrievalLimit: 20,
      },
    },
  ],
  resources: { preset: ["rag"] },
  rag: {
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      // In live mode: pass the key directly (env var name differs from LLM default).
      // In mock mode: point at the local interceptor.
      ...(LIVE_MODE ? { apiKey: OPENAI_KEY! } : { baseUrl: OPENAI_BASE }),
    },
  },
  security: {
    resolveLLMRuntimeConfig: async () => ({
      apiKey: LIVE_MODE ? OPENAI_KEY! : "test-key",
    }),
  },
  dbConfig: { url: ":memory:" },
});

// ─── helpers ──────────────────────────────────────────────────────────────────

async function runTurn(
  content: string,
  threadId?: string,
): Promise<{ threadId: string; answer: string }> {
  const result = await copilotz.run(
    {
      content,
      sender: { type: "user", id: "user-1", name: "User" },
      target: "assistant",
      ...(threadId ? { thread: { id: threadId } } : {}),
    },
    { stream: true },
  );

  const tokens: string[] = [];
  for await (const event of result.events) {
    if (event.type === "TOKEN") {
      const p = event.payload as { token?: string; isReasoning?: boolean };
      if (p.token && !p.isReasoning) tokens.push(p.token);
    }
  }
  await result.done;
  return { threadId: result.threadId, answer: tokens.join("") };
}

/** Poll until a long_term_memory node with the given status is found. */
async function waitForLongTermMemory(
  threadId: string,
  namespace: string,
  status: "ready" | "pending" | "failed",
  timeoutMs = LIVE_MODE ? 60_000 : 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await copilotz.db.query<Record<string, unknown>>(
      `SELECT * FROM "nodes"
       WHERE "namespace" = $1
         AND "type" = 'long_term_memory'
         AND "source_type" = 'thread'
         AND "source_id" = $2
         AND "data"->>'status' = $3
       ORDER BY ("data"->>'sequence')::bigint DESC
       LIMIT 1`,
      [namespace, threadId, status],
    );
    if (rows.rows.length > 0) return rows.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Timed out waiting for long_term_memory with status=${status}`,
  );
}

// ─── example run ─────────────────────────────────────────────────────────────

try {
  // Turn 1 — first user/agent pair (~30 chars, below threshold).
  const turn1 = await runTurn("Tell me about Copilotz memory design.");
  const threadId = turn1.threadId;
  console.log(`Thread: ${threadId}`);
  console.log(`Turn 1: ${turn1.answer}`);

  // Turn 2 — still accumulating in the hot window.
  const turn2 = await runTurn("How does the threshold work?", threadId);
  console.log(`Turn 2: ${turn2.answer}`);

  // Turn 3 — should cross the estimated-token threshold (50 tokens total of
  // projected agent + user content). The trigger reserves a pending node and
  // the consolidation event is queued with lower priority than interactive work.
  const turn3 = await runTurn(
    "What is the pending-to-ready transition?",
    threadId,
  );
  console.log(`Turn 3: ${turn3.answer}`);

  // Wait for the background consolidation to finish.
  console.log("Waiting for consolidation…");
  const memoryRow = await waitForLongTermMemory(
    threadId,
    "example-long-term-memory",
    "ready",
  );

  const memoryData = memoryRow.data as Record<string, unknown>;
  const memoryContent = typeof memoryRow.content === "string"
    ? memoryRow.content
    : "";

  console.log(
    `\nLong-term memory ready (sequence=${memoryData.sequence}):\n${memoryContent}\n`,
  );

  assert(
    memoryContent.includes("## LONG-TERM CONVERSATION MEMORY"),
    "Expected memory content to start with the standard heading",
  );
  assert(
    memoryContent.includes("Work state"),
    "Expected memory content to include work state section",
  );
  assert(
    memoryContent.includes("Relevant memory"),
    "Expected memory content to include memory items section",
  );
  assertEquals(
    memoryData.status,
    "ready",
    "Expected checkpoint status to be ready",
  );
  assertEquals(
    memoryData.schemaVersion,
    "1",
    "Expected schemaVersion to be 1",
  );
  assert(
    typeof memoryData.contentHash === "string" &&
      memoryData.contentHash.length > 0,
    "Expected contentHash to be set",
  );

  // Verify the memory items were persisted in the graph.
  const itemRows = await copilotz.db.query<{ id: string; name: string }>(
    `SELECT "id", "name"
     FROM "nodes"
     WHERE "namespace" = $1
       AND "type" = 'memory_item'
       AND "source_type" = 'long_term_memory'
     ORDER BY "created_at" ASC`,
    ["example-long-term-memory"],
  );
  assert(
    itemRows.rows.length >= 1,
    `Expected at least one memory_item node, got ${itemRows.rows.length}`,
  );
  console.log(
    `Memory items persisted: ${itemRows.rows.map((r) => r.name).join(", ")}`,
  );

  // Turn 4 — memory is now ready. The next LLM call should include the
  // long-term memory content in the system prompt.
  const turn4 = await runTurn(
    "Summarize what we've discussed so far.",
    threadId,
  );
  console.log(`Turn 4 (after memory ready): ${turn4.answer}`);

  // The LLM request that produced turn 4 should have the memory content in
  // its system message. Find the last non-consolidation request.
  const turn4Request = [...llmRequests].reverse().find(
    (r) => !isConsolidationBody(r as Record<string, unknown>),
  )!;
  const messages = turn4Request.messages as Array<
    { role: string; content: string }
  >;
  const systemMessage = messages.find((m) => m.role === "system");
  assert(systemMessage !== undefined, "Expected a system message in turn 4");
  assert(
    systemMessage.content.includes("## LONG-TERM CONVERSATION MEMORY"),
    "Expected turn 4 system prompt to contain the long-term memory block",
  );
  // In mock mode the LLM returns deterministic item names we can check directly.
  if (!LIVE_MODE) {
    assert(
      systemMessage.content.includes("Memory checkpoint design"),
      "Expected turn 4 system prompt to contain memory item names",
    );

    // History after the memory boundary should NOT include messages from before it.
    const historyInTurn4 = messages.filter((m) =>
      m.role === "user" || m.role === "assistant"
    );
    const containsArchivedContent = historyInTurn4.some((m) =>
      m.content.includes("Chat reply 1") || m.content.includes("Chat reply 2")
    );
    assert(
      !containsArchivedContent,
      "Expected archived history to be replaced by the memory block, not repeated verbatim",
    );
  }

  // Final state summary.
  const allMessages = await copilotz.ops.getMessageHistoryFromGraph(threadId);
  const consolidationCount = llmRequests.filter(
    (r) => isConsolidationBody(r as Record<string, unknown>),
  ).length;
  console.log(`\nAll persisted messages: ${allMessages.length}`);
  console.log(`Total LLM requests:     ${llmRequests.length}`);
  console.log(`  Chat (streaming):     ${chatCallCount}`);
  console.log(`  Consolidation:        ${consolidationCount}`);

  console.log("\nLong-term memory e2e example passed.");
} finally {
  globalThis.fetch = originalFetch;
  await copilotz.shutdown();
}
