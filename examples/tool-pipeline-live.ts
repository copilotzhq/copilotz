/**
 * Live tool-pipeline end-to-end example.
 *
 * This uses a real OpenAI model to choose and emit a Copilotz pipeline, while
 * keeping both tools deterministic. It verifies parsing, jq transformation,
 * deep argument merging, sequential durable execution, and the final LLM turn.
 *
 * Run with:
 *   deno run -A --env examples/tool-pipeline-live.ts
 *
 * Optional:
 *   COPILOTZ_E2E_MODEL=gpt-5.4 deno run -A --env examples/tool-pipeline-live.ts
 */

import { createCopilotz } from "../index.ts";
import type { Tool } from "../types/index.ts";
import type { ToolInvocation } from "../runtime/llm/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const API_KEY = Deno.env.get("OPENAI_KEY") ||
  Deno.env.get("OPENAI_API_KEY") ||
  Deno.env.get("DEFAULT_OPENAI_KEY") ||
  Deno.env.get("LLM_API_KEY") ||
  Deno.env.get("API_KEY");

if (!API_KEY) {
  console.error(
    "❌  OpenAI API key not found. Run with: deno run -A --env examples/tool-pipeline-live.ts",
  );
  Deno.exit(1);
}

const MODEL = Deno.env.get("COPILOTZ_E2E_MODEL") || "gpt-5.4";
let analysisArguments: Record<string, unknown> | null = null;

const loadSalesData: Tool = {
  id: "load_sales_data",
  key: "load_sales_data",
  name: "Load Sales Data",
  description:
    "Loads deterministic sales orders. Returns region, orders, and internal metadata as JSON.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      region: { type: "string" },
    },
    required: ["region"],
  },
  execute: ({ region }: { region: string }) => ({
    region,
    orders: [
      { id: "A-100", status: "paid", amount: 120.25 },
      { id: "A-101", status: "pending", amount: 80 },
      { id: "A-102", status: "paid", amount: 49.75 },
    ],
    internal: { fetchedBy: "live-pipeline-example" },
  }),
};

const analyzeSales: Tool = {
  id: "analyze_sales",
  key: "analyze_sales",
  name: "Analyze Sales",
  description:
    "Summarizes a prepared list of sales orders. Call only with paid orders selected by the preceding pipeline stage.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      orders: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            status: { type: "string" },
            amount: { type: "number" },
          },
          required: ["id", "status", "amount"],
        },
      },
      sourceRegion: { type: "string" },
      currency: { type: "string" },
      presentation: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          decimals: { type: "number" },
        },
        required: ["label", "decimals"],
      },
    },
    required: ["orders", "sourceRegion", "currency", "presentation"],
  },
  execute: (args: Record<string, unknown>) => {
    analysisArguments = args;
    const orders = args.orders as Array<{ amount: number }>;
    const decimals = Number(
      (args.presentation as Record<string, unknown>).decimals,
    );
    const total = orders.reduce((sum, order) => sum + order.amount, 0);
    return {
      paidOrderCount: orders.length,
      paidTotal: Number(total.toFixed(decimals)),
      currency: args.currency,
      sourceRegion: args.sourceRegion,
    };
  },
};

const copilotz = await createCopilotz({
  namespace: "examples-tool-pipeline-live",
  agentsFile: false,
  agents: [{
    id: "sales-analyst",
    name: "Sales Analyst",
    role: "assistant",
    instructions: `
You are validating Copilotz tool pipelines. For the user's request you must:
1. Use load_sales_data for region "south".
2. In the same tool-call line, pipe its output through jq. Select only paid
   orders and reshape the value to exactly {orders, sourceRegion}.
3. Pipe that object into analyze_sales. Explicitly pass currency "USD" and
   presentation {label: "live-e2e", decimals: 2} in analyze_sales arguments.
4. Use exactly one sequential pipeline, not separate tool-call lines or turns.
5. After receiving the result, report the paid order count and total briefly.
`,
    allowedTools: ["load_sales_data", "analyze_sales"],
    llmOptions: {
      provider: "openai",
      model: MODEL,
      openaiApi: "responses",
    },
  }],
  tools: [loadSalesData, analyzeSales],
  security: {
    resolveLLMRuntimeConfig: ({ provider }) => ({
      apiKey: provider === "openai" ? API_KEY : undefined,
    }),
  },
  dbConfig: { url: ":memory:" },
});

console.log(`Live model: ${MODEL}`);
console.log("User: Analyze paid sales for the south region.");

try {
  const result = await copilotz.run({
    content: "Analyze paid sales for the south region.",
    sender: { type: "user", id: "live-user", name: "User" },
    target: "sales-analyst",
  }, { stream: true });

  let rootCall: ToolInvocation | null = null;
  let llmFailure: string | null = null;
  const finalTokens: string[] = [];

  for await (const event of result.events) {
    if (event.type === "TOOL_CALL") {
      const candidate = (event.payload as { toolCall?: ToolInvocation })
        .toolCall;
      if (candidate?.pipeline) rootCall = candidate;
    }
    if (event.type === "LLM_RESULT") {
      const payload = event.payload as {
        status?: string;
        answer?: string | null;
        error?: { message?: string | null } | null;
      };
      if (payload.status === "failed") {
        llmFailure = payload.error?.message ?? payload.answer ??
          "LLM call failed";
      }
    }
    if (event.type === "TOKEN") {
      const payload = event.payload as {
        token?: string;
        isReasoning?: boolean;
      };
      if (payload.token && !payload.isReasoning) {
        finalTokens.push(payload.token);
      }
    }
  }

  await result.done;
  if (llmFailure) throw new Error(llmFailure);

  const capturedRootCall = rootCall as ToolInvocation | null;
  assert(
    capturedRootCall?.pipeline,
    "The live model did not emit a pipeline.",
  );
  assert(
    capturedRootCall.pipeline.stages.length === 3,
    `Expected tool | jq | tool, got ${capturedRootCall.pipeline.stages.length} stages.`,
  );
  assert(
    capturedRootCall.pipeline.stages.map((stage) => stage.type).join("|") ===
      "tool|jq|tool",
    "Expected a tool | jq | tool pipeline.",
  );

  const capturedAnalysisArguments = analysisArguments as
    | Record<
      string,
      unknown
    >
    | null;
  assert(
    capturedAnalysisArguments,
    "The downstream analysis tool did not execute.",
  );
  const orders = capturedAnalysisArguments.orders as Array<
    Record<string, unknown>
  >;
  assert(orders.length === 2, "jq did not select exactly two paid orders.");
  assert(
    orders.every((order) => order.status === "paid"),
    "jq allowed a non-paid order through.",
  );
  assert(
    capturedAnalysisArguments.sourceRegion === "south",
    "jq did not map region to sourceRegion.",
  );
  assert(
    capturedAnalysisArguments.currency === "USD",
    "Explicit downstream arguments were not merged.",
  );
  assert(
    (capturedAnalysisArguments.presentation as Record<string, unknown>)
      .label ===
      "live-e2e",
    "Nested explicit downstream arguments were not preserved.",
  );

  const executions = await copilotz.db.query<{
    id: string;
    data: Record<string, unknown>;
  }>(
    `SELECT "id", "data"
     FROM "nodes"
     WHERE "data"->>'threadId' = $1
       AND "type" = 'tool_execution'
     ORDER BY "created_at" ASC`,
    [result.threadId],
  );
  assert(
    executions.rows.length === 2,
    `Expected two durable tool executions, got ${executions.rows.length}.`,
  );
  assert(
    executions.rows.every((row) => row.data.status === "completed"),
    "Not all pipeline tool executions completed.",
  );

  const answer = finalTokens.join("").trim();
  assert(answer.length > 0, "The live model produced no final answer.");

  console.log(
    `Pipeline: ${
      capturedRootCall.pipeline.stages.map((stage) =>
        stage.type === "tool" ? stage.tool.id : `jq(${stage.filter})`
      ).join(" | ")
    }`,
  );
  console.log(
    `Merged analyze_sales args: ${JSON.stringify(capturedAnalysisArguments)}`,
  );
  console.log(`Durable executions: ${executions.rows.length}`);
  console.log(`Assistant: ${answer}`);
  console.log("✅ Live tool-pipeline example passed.");
} finally {
  await copilotz.shutdown();
}
