/**
 * Prompt Cache Diagnostics — real Copilotz run() E2E prompt-cache probe.
 *
 * This example uses `copilotz.run()` so it exercises the actual Copilotz
 * event pipeline: agent context, thread metadata, tools, persisted history,
 * multi-agent turns, provider adapters, and usage persistence.
 *
 * Run with:
 *   OPENAI_KEY=<key> deno run -A --env examples/prompt-cache-diagnostics.ts
 *
 * Optional:
 *   CACHE_DIAGNOSTIC_MODEL=gpt-5.4
 *   CACHE_DIAGNOSTIC_OPENAI_API=responses
 *   CACHE_DIAGNOSTIC_RUNS=3
 *   CACHE_DIAGNOSTIC_ONLY=tools
 */

import { createCopilotz } from "../index.ts";
import type { TokenUsage } from "../runtime/llm/types.ts";
import type { Agent, MessagePayload, Tool } from "../types/index.ts";

const API_KEY = Deno.env.get("OPENAI_KEY") || Deno.env.get("OPENAI_API_KEY") ||
  Deno.env.get("DEFAULT_OPENAI_KEY") || Deno.env.get("LLM_API_KEY") ||
  Deno.env.get("API_KEY");

if (!API_KEY) {
  console.error(
    "OPENAI_KEY is not set. Run with: OPENAI_KEY=<key> deno run -A --env examples/prompt-cache-diagnostics.ts",
  );
  Deno.exit(1);
}

const OPENAI_API_KEY = API_KEY;
const MODEL = Deno.env.get("CACHE_DIAGNOSTIC_MODEL") || "gpt-5.4";
const OPENAI_API = Deno.env.get("CACHE_DIAGNOSTIC_OPENAI_API") ||
  "responses";
const ONLY_SCENARIO = Deno.env.get("CACHE_DIAGNOSTIC_ONLY")?.toLowerCase();
const REPEAT_COUNT = Math.max(
  2,
  Number(Deno.env.get("CACHE_DIAGNOSTIC_RUNS") || "2"),
);
const NAMESPACE = `prompt-cache-diagnostics-${crypto.randomUUID()}`;

const STATIC_POLICY = Array.from(
  { length: 90 },
  (_, index) =>
    `Stable policy ${
      index + 1
    }: preserve the exact diagnostic task framing, answer briefly, avoid introducing new assumptions, and focus on repeatable cache behavior.`,
).join("\n");

const BASE_INSTRUCTIONS = [
  "You are a prompt-cache diagnostic assistant.",
  "Answer in one short sentence.",
  "Do not use tools unless the user explicitly asks you to.",
  "Keep the wording deterministic and compact.",
  "",
  STATIC_POLICY,
].join("\n");

const baseLlmOptions = {
  provider: "openai" as const,
  model: MODEL,
  openaiApi: OPENAI_API === "chat_completions"
    ? "chat_completions" as const
    : "responses" as const,
  temperature: 0,
  maxTokens: 120,
  limitEstimatedInputTokens: 100_000,
};

const stableSingleAgent: Agent = {
  id: "stable-single",
  name: "StableSingle",
  role: "diagnostic assistant",
  description: "Single-agent baseline with no tools.",
  instructions: BASE_INSTRUCTIONS,
  allowedTools: null,
  llmOptions: baseLlmOptions,
};

const metadataAgent: Agent = {
  ...stableSingleAgent,
  id: "metadata-agent",
  name: "MetadataAgent",
  description: "Single-agent prompt with thread and user metadata.",
};

const toolAgent: Agent = {
  ...stableSingleAgent,
  id: "tool-agent",
  name: "ToolAgent",
  description: "Single-agent prompt with a stable custom tool catalog.",
  allowedTools: ["cache_echo", "cache_weather", "cache_ledger"],
};

const plannerAgent: Agent = {
  id: "planner",
  name: "Planner",
  role: "planner",
  description: "First multi-agent participant.",
  instructions: [
    BASE_INSTRUCTIONS,
    "Give one short planning sentence.",
  ].join("\n\n"),
  allowedTools: ["cache_echo"],
  llmOptions: baseLlmOptions,
};

const reviewerAgent: Agent = {
  id: "reviewer",
  name: "Reviewer",
  role: "reviewer",
  description: "Second multi-agent participant.",
  instructions: [
    BASE_INSTRUCTIONS,
    "Review the prior message in one short sentence and then stop.",
  ].join("\n\n"),
  allowedTools: ["cache_echo"],
  llmOptions: baseLlmOptions,
};

const analystAgent: Agent = {
  ...stableSingleAgent,
  id: "analyst",
  name: "Analyst",
  role: "analysis specialist",
  description: "Agent with echo and weather tools.",
  allowedTools: ["cache_echo", "cache_weather"],
};

const operatorAgent: Agent = {
  ...stableSingleAgent,
  id: "operator",
  name: "Operator",
  role: "operations specialist",
  description: "Agent with ledger-only tooling.",
  allowedTools: ["cache_ledger"],
};

const diagnosticTools: Tool[] = [
  {
    id: "cache_echo",
    key: "cache_echo",
    name: "Cache Echo",
    description:
      "Returns a deterministic echo for prompt-cache diagnostics. Use only when explicitly requested.",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string", description: "Text to echo back." },
      },
      required: ["value"],
    },
    execute: ({ value }: { value?: string }) => ({
      echoed: value ?? "",
      diagnostic: "stable",
    }),
  },
  {
    id: "cache_weather",
    key: "cache_weather",
    name: "Cache Weather",
    description:
      "Returns deterministic weather-shaped data for prompt-cache diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City to inspect." },
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description: "Unit system.",
        },
      },
      required: ["city"],
    },
    execute: ({ city, units }: { city?: string; units?: string }) => ({
      city: city ?? "unknown",
      units: units ?? "metric",
      temperature: 21,
      condition: "clear",
    }),
  },
  {
    id: "cache_ledger",
    key: "cache_ledger",
    name: "Cache Ledger",
    description:
      "Returns deterministic ledger-shaped data for prompt-cache diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account identifier." },
        includePending: {
          type: "boolean",
          description: "Whether pending rows should be included.",
        },
      },
      required: ["accountId"],
    },
    execute: (
      { accountId, includePending }: {
        accountId?: string;
        includePending?: boolean;
      },
    ) => ({
      accountId: accountId ?? "acct_demo",
      includePending: Boolean(includePending),
      balance: 1000,
      currency: "USD",
    }),
  },
];

const toolsByKey = new Map(diagnosticTools.map((tool) => [tool.key, tool]));

type UsageRow = {
  scenario: string;
  iteration: number;
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
  source: string | null;
};

type Scenario = {
  name: string;
  run: (iteration: number) => Promise<UsageRow[]>;
};

function pickTools(keys: string[]): Tool[] {
  return keys.map((key) => toolsByKey.get(key)).filter((tool): tool is Tool =>
    Boolean(tool)
  );
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageRowFromPayload(
  scenario: string,
  iteration: number,
  payload: {
    agent?: { id?: string | null; name?: string };
    usage?: TokenUsage;
  },
): UsageRow | null {
  if (!payload.usage) return null;
  return {
    scenario,
    iteration,
    agentId: payload.agent?.id ?? payload.agent?.name ?? "unknown",
    inputTokens: toNumber(payload.usage.inputTokens),
    outputTokens: toNumber(payload.usage.outputTokens),
    cacheReadInputTokens: toNumber(payload.usage.cacheReadInputTokens),
    totalTokens: toNumber(payload.usage.totalTokens),
    source: payload.usage.source ?? null,
  };
}

function usageRowFromNode(
  scenario: string,
  iteration: number,
  data: Record<string, unknown>,
): UsageRow | null {
  if (data.source !== "provider" && data.source !== "estimated") return null;
  return {
    scenario,
    iteration,
    agentId: typeof data.agentId === "string" ? data.agentId : "unknown",
    inputTokens: toNumber(data.inputTokens),
    outputTokens: toNumber(data.outputTokens),
    cacheReadInputTokens: toNumber(data.cacheReadInputTokens),
    totalTokens: toNumber(data.totalTokens),
    source: typeof data.source === "string" ? data.source : null,
  };
}

async function collectUsageRows(
  copilotz: Awaited<ReturnType<typeof createCopilotz>>,
  scenario: string,
  iteration: number,
  result: Awaited<
    ReturnType<Awaited<ReturnType<typeof createCopilotz>>["run"]>
  >,
): Promise<UsageRow[]> {
  const rows: UsageRow[] = [];

  for await (const event of result.events) {
    if (event.type !== "LLM_RESULT") continue;
    const row = usageRowFromPayload(
      scenario,
      iteration,
      event.payload as {
        agent?: { id?: string | null; name?: string };
        usage?: TokenUsage;
      },
    );
    if (row) rows.push(row);
  }

  await result.done;
  if (rows.length > 0) return rows;

  const usageNodes = await copilotz.ops.getNodesByNamespace(
    NAMESPACE,
    "llm_usage",
  );
  for (const node of usageNodes.reverse()) {
    const data = node.data && typeof node.data === "object"
      ? node.data as Record<string, unknown>
      : {};
    if (data.threadId !== result.threadId) continue;
    const row = usageRowFromNode(scenario, iteration, data);
    if (row) rows.push(row);
  }

  return rows;
}

async function runTurn(
  copilotz: Awaited<ReturnType<typeof createCopilotz>>,
  scenario: string,
  iteration: number,
  message: MessagePayload,
  agents: Agent[],
  tools: Tool[] = [],
): Promise<UsageRow[]> {
  const result = await copilotz.run(message, {
    stream: true,
    namespace: NAMESPACE,
    agents,
    tools,
  });
  const rows = await collectUsageRows(copilotz, scenario, iteration, result);
  if (rows.length === 0) {
    throw new Error(`No usage rows found for ${scenario} run ${iteration}`);
  }
  return rows;
}

function printUsageRow(row: UsageRow): void {
  const inputHitPct = row.inputTokens > 0
    ? `${Math.round((row.cacheReadInputTokens / row.inputTokens) * 100)}%`
    : "0%";
  const totalSharePct = row.totalTokens > 0
    ? `${Math.round((row.cacheReadInputTokens / row.totalTokens) * 100)}%`
    : "0%";
  console.log(
    [
      `run=${row.iteration}`,
      `agent=${row.agentId}`,
      `input=${row.inputTokens}`,
      `cached=${row.cacheReadInputTokens}`,
      `cache/input=${inputHitPct}`,
      `cache/total=${totalSharePct}`,
      `output=${row.outputTokens}`,
      `total=${row.totalTokens}`,
      `source=${row.source ?? "unknown"}`,
    ].join(" | "),
  );
}

function printSummary(rows: UsageRow[]): void {
  console.log("\n=== Summary ===");
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const key = `${row.scenario} :: ${row.agentId}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  for (const [key, groupRows] of groups) {
    const totalInput = groupRows.reduce((sum, row) => sum + row.inputTokens, 0);
    const totalCached = groupRows.reduce(
      (sum, row) => sum + row.cacheReadInputTokens,
      0,
    );
    const totalTokens = groupRows.reduce(
      (sum, row) => sum + row.totalTokens,
      0,
    );
    const inputPct = totalInput > 0
      ? Math.round((totalCached / totalInput) * 100)
      : 0;
    const totalPct = totalTokens > 0
      ? Math.round((totalCached / totalTokens) * 100)
      : 0;
    console.log(
      `${key} -> cached/input ${totalCached}/${totalInput} (${inputPct}%), cached/total ${totalCached}/${totalTokens} (${totalPct}%)`,
    );
  }

  console.log(
    "\nInterpretation: cache/input is the prompt-cache hit rate. Cache/total is lower when output or reasoning tokens are large, and is the ratio most dashboards make visually obvious.",
  );
}

function diagnosticMessage(
  target: string,
  threadExternalId: string,
  threadName: string,
  phrase: string,
  participants: string[],
  metadata?: Record<string, unknown>,
  senderMetadata?: Record<string, unknown>,
): MessagePayload {
  return {
    content:
      `Run the cache diagnostic. Reply with the exact phrase: ${phrase}.`,
    sender: {
      type: "user",
      name: "CacheTester",
      ...(senderMetadata ? { metadata: senderMetadata } : {}),
    },
    target,
    thread: {
      externalId: threadExternalId,
      name: threadName,
      participants,
      ...(metadata ? { metadata } : {}),
    },
  };
}

const copilotz = await createCopilotz({
  namespace: NAMESPACE,
  agents: [
    stableSingleAgent,
    metadataAgent,
    toolAgent,
    plannerAgent,
    reviewerAgent,
    analystAgent,
    operatorAgent,
  ],
  tools: diagnosticTools,
  multiAgent: {
    enabled: true,
    maxAgentTurns: 4,
  },
  security: {
    resolveLLMRuntimeConfig: ({ provider }) => {
      if (provider === "openai") return { apiKey: OPENAI_API_KEY };
      return { apiKey: Deno.env.get("LLM_API_KEY") };
    },
  },
  dbConfig: { url: ":memory:" },
});

const scenarios: Scenario[] = [
  {
    name: "single-agent stable baseline",
    run: (iteration) =>
      runTurn(
        copilotz,
        "single-agent stable baseline",
        iteration,
        diagnosticMessage(
          "stable-single",
          `stable-baseline-${iteration}`,
          "Prompt Cache Stable Baseline",
          "stable baseline complete",
          ["CacheTester", "stable-single"],
        ),
        [stableSingleAgent],
      ),
  },
  {
    name: "single-agent stable metadata",
    run: (iteration) =>
      runTurn(
        copilotz,
        "single-agent stable metadata",
        iteration,
        diagnosticMessage(
          "metadata-agent",
          `stable-metadata-${iteration}`,
          "Prompt Cache Stable Metadata",
          "stable metadata complete",
          ["CacheTester", "metadata-agent"],
          {
            account: "acct_cache_diagnostic",
            workspace: "workspace_cache_diagnostic",
            tier: "enterprise",
          },
          {
            plan: "enterprise",
            locale: "en-US",
            cacheSegment: "stable",
          },
        ),
        [metadataAgent],
      ),
  },
  {
    name: "single-agent changing metadata",
    run: (iteration) =>
      runTurn(
        copilotz,
        "single-agent changing metadata",
        iteration,
        diagnosticMessage(
          "metadata-agent",
          `changing-metadata-${iteration}`,
          "Prompt Cache Changing Metadata",
          "changing metadata complete",
          ["CacheTester", "metadata-agent"],
          {
            account: "acct_cache_diagnostic",
            volatileRequestId: crypto.randomUUID(),
          },
          {
            plan: "enterprise",
            locale: "en-US",
            volatileRunId: crypto.randomUUID(),
          },
        ),
        [metadataAgent],
      ),
  },
  {
    name: "single-agent stable tools",
    run: (iteration) =>
      runTurn(
        copilotz,
        "single-agent stable tools",
        iteration,
        diagnosticMessage(
          "tool-agent",
          `stable-tools-${iteration}`,
          "Prompt Cache Stable Tools",
          "stable tools complete",
          ["CacheTester", "tool-agent"],
        ),
        [toolAgent],
        diagnosticTools,
      ),
  },
  {
    name: "multi-agent stable team",
    run: async (iteration) => {
      const threadExternalId = `multi-agent-stable-${iteration}`;
      const plannerRows = await runTurn(
        copilotz,
        "multi-agent stable team",
        iteration,
        diagnosticMessage(
          "planner",
          threadExternalId,
          "Prompt Cache Multi Agent",
          "multi agent planner complete",
          ["CacheTester", "planner", "reviewer"],
          {
            account: "acct_cache_diagnostic",
            workspace: "workspace_cache_diagnostic",
          },
        ),
        [plannerAgent, reviewerAgent],
        pickTools(["cache_echo"]),
      );
      const reviewerRows = await runTurn(
        copilotz,
        "multi-agent stable team",
        iteration,
        diagnosticMessage(
          "reviewer",
          threadExternalId,
          "Prompt Cache Multi Agent",
          "multi agent reviewer complete",
          ["CacheTester", "planner", "reviewer"],
          {
            account: "acct_cache_diagnostic",
            workspace: "workspace_cache_diagnostic",
          },
        ),
        [plannerAgent, reviewerAgent],
        pickTools(["cache_echo"]),
      );
      return [...plannerRows, ...reviewerRows];
    },
  },
  {
    name: "changing agents different tools",
    run: async (iteration) => {
      const analystRows = await runTurn(
        copilotz,
        "changing agents different tools",
        iteration,
        diagnosticMessage(
          "analyst",
          `different-tools-analyst-${iteration}`,
          "Prompt Cache Different Agent Tools",
          "analyst tools complete",
          ["CacheTester", "analyst", "operator"],
        ),
        [analystAgent, operatorAgent],
        pickTools(["cache_echo", "cache_weather"]),
      );
      const operatorRows = await runTurn(
        copilotz,
        "changing agents different tools",
        iteration,
        diagnosticMessage(
          "operator",
          `different-tools-operator-${iteration}`,
          "Prompt Cache Different Agent Tools",
          "operator tools complete",
          ["CacheTester", "analyst", "operator"],
        ),
        [analystAgent, operatorAgent],
        pickTools(["cache_ledger"]),
      );
      return [...analystRows, ...operatorRows];
    },
  },
  {
    name: "multi-turn growing history",
    run: (iteration) =>
      runTurn(
        copilotz,
        "multi-turn growing history",
        iteration,
        diagnosticMessage(
          "stable-single",
          "multi-turn-growing-history",
          "Prompt Cache Growing History",
          `multi turn ${iteration} complete`,
          ["CacheTester", "stable-single"],
          { conversationShape: "single-agent-growing-history" },
        ),
        [stableSingleAgent],
      ),
  },
  {
    name: "multi-turn changing agents tools",
    run: async (iteration) => {
      const threadExternalId = "multi-turn-changing-agents-tools";
      const analystRows = await runTurn(
        copilotz,
        "multi-turn changing agents tools",
        iteration,
        diagnosticMessage(
          "analyst",
          threadExternalId,
          "Prompt Cache Multi Turn Agent Tools",
          `multi turn analyst ${iteration} complete`,
          ["CacheTester", "analyst", "operator"],
          { conversationShape: "multi-agent-growing-history" },
        ),
        [analystAgent, operatorAgent],
        pickTools(["cache_echo", "cache_weather"]),
      );
      const operatorRows = await runTurn(
        copilotz,
        "multi-turn changing agents tools",
        iteration,
        diagnosticMessage(
          "operator",
          threadExternalId,
          "Prompt Cache Multi Turn Agent Tools",
          `multi turn operator ${iteration} complete`,
          ["CacheTester", "analyst", "operator"],
          { conversationShape: "multi-agent-growing-history" },
        ),
        [analystAgent, operatorAgent],
        pickTools(["cache_ledger"]),
      );
      return [...analystRows, ...operatorRows];
    },
  },
];

try {
  console.log("Prompt cache diagnostics");
  console.log(`model=${MODEL}`);
  console.log(`openaiApi=${baseLlmOptions.openaiApi}`);
  console.log(`repeatCount=${REPEAT_COUNT}`);
  console.log(`namespace=${NAMESPACE}`);
  if (ONLY_SCENARIO) console.log(`onlyScenario=${ONLY_SCENARIO}`);

  const rows: UsageRow[] = [];
  for (
    const scenario of scenarios.filter((scenario) =>
      !ONLY_SCENARIO || scenario.name.toLowerCase().includes(ONLY_SCENARIO)
    )
  ) {
    console.log(`\n=== ${scenario.name} ===`);
    for (let iteration = 1; iteration <= REPEAT_COUNT; iteration++) {
      const scenarioRows = await scenario.run(iteration);
      for (const row of scenarioRows) {
        rows.push(row);
        printUsageRow(row);
      }
    }
  }

  printSummary(rows);
} finally {
  await copilotz.shutdown();
}
