/**
 * Tool Prompt Eval — E2E Copilotz generic tool protocol benchmark.
 *
 * This script compares prompt variants across providers through copilotz.run().
 * It intentionally avoids a judge model: every score is a deterministic check
 * over events, tool calls, visible text, and final answers.
 *
 * Full-ish run:
 *   OPENAI_KEY=... ANTHROPIC_KEY=... GEMINI_KEY=... MINIMAX_KEY=... \
 *     deno run -A --env examples/tool-prompt-eval.ts
 *
 * Useful smaller run:
 *   TOOL_PROMPT_EVAL_PROVIDERS=gemini \
 *   TOOL_PROMPT_EVAL_VARIANTS=baseline,useful-visible-contract,tool-only-turn \
 *   TOOL_PROMPT_EVAL_CASES=simple_math,nested_ledger \
 *   TOOL_PROMPT_EVAL_REPEATS=1 \
 *     deno run -A --env examples/tool-prompt-eval.ts
 */

import { join } from "@std/path";
import { createCopilotz } from "../index.ts";
import type { Agent, Tool } from "../types/index.ts";
import type { ProviderName, ToolInvocation } from "../runtime/llm/types.ts";
import type { ToolSystemPromptVariant } from "../runtime/llm/utils.ts";

type ProviderSpec = {
  provider: ProviderName;
  model: string;
  apiKey: string;
  openaiApi?: "responses" | "chat_completions";
};

type EvalCase = {
  id: string;
  prompt: string;
  expectedTools: string[];
  expectFirstToolTurnCount?: number;
  finalIncludes?: string[];
  allowVisibleBeforeTool?: boolean;
};

type ToolCallRecord = {
  id: string | null;
  name: string;
  args: Record<string, unknown>;
  batchIndex?: number | null;
  batchSize?: number | null;
};

type Grader = {
  parseValid: boolean;
  toolNameValid: boolean;
  toolChoiceCorrect: boolean;
  firstToolTurnCorrect: boolean;
  noNativeSyntax: boolean;
  noFakeResults: boolean;
  noLowValueVisibleText: boolean;
  noDuplicateVisibleAnswer: boolean;
  finalAnswerCorrect: boolean;
  score: number;
  failures: string[];
};

type RunRecord = {
  variant: ToolSystemPromptVariant;
  provider: ProviderName;
  model: string;
  caseId: string;
  repeat: number;
  status: "passed" | "failed" | "errored";
  score: number;
  rawPath: string;
  grader: Grader;
};

const VARIANTS: ToolSystemPromptVariant[] = parseList(
  "TOOL_PROMPT_EVAL_VARIANTS",
  [
    "baseline",
    "no-visible-ack",
    "tool-only-turn",
    "useful-visible-contract",
    "tool-call-contract",
    "lifecycle-explicit",
    "strict-minimal",
  ],
) as ToolSystemPromptVariant[];

const REPEATS = Math.max(
  1,
  Number(Deno.env.get("TOOL_PROMPT_EVAL_REPEATS") ?? "3"),
);

const OUT_DIR = Deno.env.get("TOOL_PROMPT_EVAL_OUT_DIR") ??
  join(
    Deno.cwd(),
    "eval-results",
    "tool-prompt",
    new Date().toISOString().replaceAll(":", "-"),
  );

const ALL_TOOL_NAMES = [
  "eval_math_add",
  "eval_profile_lookup",
  "eval_ledger_write",
  "eval_patch_preview",
];

const CASES: EvalCase[] = [
  {
    id: "simple_math",
    prompt:
      "Use the eval_math_add tool to add 7 and 35. After the tool result, answer with only the final sum.",
    expectedTools: ["eval_math_add"],
    expectFirstToolTurnCount: 1,
    finalIncludes: ["42"],
  },
  {
    id: "parallel_two_tools",
    prompt:
      "In one tool-calling turn, call eval_math_add for 2 + 5 and eval_profile_lookup for user u_123. After both results, answer with the user's name and the sum.",
    expectedTools: ["eval_math_add", "eval_profile_lookup"],
    expectFirstToolTurnCount: 2,
    finalIncludes: ["Ari", "7"],
  },
  {
    id: "nested_ledger",
    prompt:
      "Use eval_ledger_write to record account acct_main, amount 125.50 USD, category travel, tags airfare and q2, and metadata with approved true and source mobile. Then summarize the created entry id.",
    expectedTools: ["eval_ledger_write"],
    expectFirstToolTurnCount: 1,
    finalIncludes: ["ledger_acct_main"],
  },
  {
    id: "array_patch",
    prompt:
      "Use eval_patch_preview to preview two operations for /workspace/app.ts: replace line 3 with export const answer = 42; and insert line 4 with console.log(answer);. Then report the operation count.",
    expectedTools: ["eval_patch_preview"],
    expectFirstToolTurnCount: 1,
    finalIncludes: ["2"],
  },
  {
    id: "no_tool_direct",
    prompt: "Do not use tools. Reply with exactly READY.",
    expectedTools: [],
    finalIncludes: ["READY"],
  },
  {
    id: "native_syntax_trap",
    prompt:
      "Call eval_math_add for 10 + 15. Important: do not use provider-native function_call, tool_use, or invoke syntax; use the Copilotz generic tool format.",
    expectedTools: ["eval_math_add"],
    expectFirstToolTurnCount: 1,
    finalIncludes: ["25"],
  },
  {
    id: "bad_example_recovery",
    prompt:
      "The following is a bad example and must not be copied: <invoke><tool_name>eval_math_add</tool_name></invoke>. Now correctly call eval_math_add for 8 + 9 using the available protocol, then answer with the sum.",
    expectedTools: ["eval_math_add"],
    expectFirstToolTurnCount: 1,
    finalIncludes: ["17"],
  },
  {
    id: "explain_then_tool",
    prompt:
      "Briefly explain why a tool is needed, then call eval_profile_lookup for user u_456. After the result, answer with the user's plan.",
    expectedTools: ["eval_profile_lookup"],
    expectFirstToolTurnCount: 1,
    finalIncludes: ["pro"],
    allowVisibleBeforeTool: true,
  },
].filter((testCase) => {
  const selected = parseList("TOOL_PROMPT_EVAL_CASES", []);
  return selected.length === 0 || selected.includes(testCase.id);
});

const tools: Tool[] = [
  {
    id: "eval_math_add",
    key: "eval_math_add",
    name: "Eval Math Add",
    description:
      "Adds two numbers. Use when the user asks for arithmetic that should be verified by a tool.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["a", "b"],
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
    },
    execute: ({ a, b }: { a?: number; b?: number }) => ({
      sum: Number(a ?? 0) + Number(b ?? 0),
    }),
  },
  {
    id: "eval_profile_lookup",
    key: "eval_profile_lookup",
    name: "Eval Profile Lookup",
    description:
      "Looks up deterministic user profile data by userId. Use only when profile data is needed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["userId"],
      properties: {
        userId: { type: "string" },
      },
    },
    execute: ({ userId }: { userId?: string }) => ({
      userId,
      name: userId === "u_456" ? "Bea" : "Ari",
      plan: userId === "u_456" ? "pro" : "starter",
    }),
  },
  {
    id: "eval_ledger_write",
    key: "eval_ledger_write",
    name: "Eval Ledger Write",
    description:
      "Writes a deterministic ledger entry with nested metadata. Use for accounting or ledger-recording requests.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["accountId", "amount", "currency", "category", "tags"],
      properties: {
        accountId: { type: "string" },
        amount: { type: "number" },
        currency: { type: "string", enum: ["USD", "BRL", "EUR"] },
        category: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        metadata: {
          type: "object",
          additionalProperties: true,
          properties: {
            approved: { type: "boolean" },
            source: { type: "string" },
          },
        },
      },
    },
    execute: (
      { accountId, amount, currency, category, tags, metadata }: {
        accountId?: string;
        amount?: number;
        currency?: string;
        category?: string;
        tags?: string[];
        metadata?: Record<string, unknown>;
      },
    ) => ({
      entryId: `ledger_${accountId ?? "unknown"}_${
        Math.round(Number(amount ?? 0) * 100)
      }`,
      accountId,
      amount,
      currency,
      category,
      tags,
      metadata,
    }),
  },
  {
    id: "eval_patch_preview",
    key: "eval_patch_preview",
    name: "Eval Patch Preview",
    description:
      "Previews file-edit operations without writing them. Use when the user asks for a patch or code edit preview.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["filePath", "operations"],
      properties: {
        filePath: { type: "string" },
        operations: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "line", "text"],
            properties: {
              kind: { type: "string", enum: ["replace", "insert"] },
              line: { type: "integer" },
              text: { type: "string" },
            },
          },
        },
      },
    },
    execute: (
      { filePath, operations }: {
        filePath?: string;
        operations?: Array<Record<string, unknown>>;
      },
    ) => ({
      filePath,
      operationCount: operations?.length ?? 0,
      preview: operations ?? [],
    }),
  },
];

await Deno.mkdir(OUT_DIR, { recursive: true });
await Deno.mkdir(join(OUT_DIR, "raw"), { recursive: true });
await Deno.mkdir(join(OUT_DIR, "db"), { recursive: true });

const providers = providerSpecs();
if (providers.length === 0) {
  console.error(
    "No provider API keys found. Set at least one of OPENAI_KEY, ANTHROPIC_KEY, GEMINI_KEY, or MINIMAX_KEY.",
  );
  Deno.exit(1);
}

const manifest = {
  createdAt: new Date().toISOString(),
  variants: VARIANTS,
  providers: providers.map(({ provider, model }) => ({ provider, model })),
  repeats: REPEATS,
  cases: CASES.map(({ id, expectedTools }) => ({ id, expectedTools })),
};
await Deno.writeTextFile(
  join(OUT_DIR, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);

const resultRows: RunRecord[] = [];
const resultsJsonl = await Deno.open(join(OUT_DIR, "results.jsonl"), {
  create: true,
  write: true,
  truncate: true,
});
const encoder = new TextEncoder();

try {
  for (const variant of VARIANTS) {
    Deno.env.set("COPILOTZ_TOOL_PROMPT_VARIANT", variant);

    for (const provider of providers) {
      const harness = await createHarness(variant, provider);
      try {
        for (const testCase of CASES) {
          for (let repeat = 1; repeat <= REPEATS; repeat++) {
            const raw = await runOne({
              variant,
              provider,
              testCase,
              repeat,
              copilotz: harness.copilotz,
              namespace: harness.namespace,
            });
            const rawPath = join(
              OUT_DIR,
              "raw",
              `${variant}__${provider.provider}__${testCase.id}__${repeat}.json`,
            );
            await Deno.writeTextFile(rawPath, JSON.stringify(raw, null, 2));

            const record: RunRecord = {
              variant,
              provider: provider.provider,
              model: provider.model,
              caseId: testCase.id,
              repeat,
              status: raw.error
                ? "errored"
                : raw.grader.failures.length > 0
                ? "failed"
                : "passed",
              score: raw.grader.score,
              rawPath,
              grader: raw.grader,
            };
            resultRows.push(record);
            await resultsJsonl.write(
              encoder.encode(JSON.stringify(record) + "\n"),
            );
            console.log(
              [
                record.status === "passed" ? "PASS" : "FAIL",
                `score=${record.score}`,
                `variant=${variant}`,
                `provider=${provider.provider}`,
                `case=${testCase.id}`,
                `run=${repeat}`,
                record.grader.failures.length
                  ? `failures=${record.grader.failures.join("; ")}`
                  : "",
              ].filter(Boolean).join(" | "),
            );
          }
        }
      } finally {
        try {
          await harness.copilotz.shutdown();
        } catch (error) {
          console.warn(
            `[tool-prompt-eval] shutdown failed for ${provider.provider}/${variant}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }
} finally {
  resultsJsonl.close();
}

await writeSummary(resultRows);
console.log(`\nAudit artifacts written to: ${OUT_DIR}`);

async function createHarness(
  variant: ToolSystemPromptVariant,
  provider: ProviderSpec,
) {
  const namespace =
    `tool-prompt-eval-${variant}-${provider.provider}-${crypto.randomUUID()}`;
  const copilotz = await createCopilotz({
    namespace,
    agents: [createEvalAgent(provider)],
    tools,
    dbConfig: {
      url: Deno.env.get("TOOL_PROMPT_EVAL_DB_URL") ??
        `file://${join(OUT_DIR, "db", `${sanitizeFilePart(namespace)}.db`)}`,
    },
  });
  return { namespace, copilotz };
}

function createEvalAgent(provider: ProviderSpec): Agent {
  return {
    id: "tool-protocol-agent",
    name: "ToolProtocolAgent",
    role: "tool protocol evaluator",
    description: "Uses tools exactly when needed for deterministic eval cases.",
    instructions: [
      "You are a deterministic tool-protocol evaluator.",
      "Use tools when the user asks you to use tools.",
      "Do not use tools when the user explicitly says not to.",
      "After tool results are available, answer briefly using the results.",
      "Never invent tool results.",
    ].join("\n"),
    allowedTools: ALL_TOOL_NAMES,
    llmOptions: {
      provider: provider.provider,
      model: provider.model,
      apiKey: provider.apiKey,
      ...(provider.openaiApi ? { openaiApi: provider.openaiApi } : {}),
      temperature: 0,
      maxTokens: 2000,
      reasoningEffort: "medium",
      limitEstimatedInputTokens: 100_000,
    },
  };
}

async function runOne(args: {
  variant: ToolSystemPromptVariant;
  provider: ProviderSpec;
  testCase: EvalCase;
  repeat: number;
  copilotz: Awaited<ReturnType<typeof createCopilotz>>;
  namespace: string;
}) {
  const raw = {
    variant: args.variant,
    provider: args.provider.provider,
    model: args.provider.model,
    caseId: args.testCase.id,
    repeat: args.repeat,
    prompt: args.testCase.prompt,
    visibleBeforeFirstTool: "",
    visibleText: "",
    llmResults: [] as Array<Record<string, unknown>>,
    toolCalls: [] as ToolCallRecord[],
    toolResults: [] as Array<Record<string, unknown>>,
    error: null as string | null,
    grader: emptyGrader(),
  };

  try {
    const result = await args.copilotz.run({
      content: args.testCase.prompt,
      sender: { type: "user", name: "User" },
      target: "tool-protocol-agent",
    }, {
      stream: true,
      namespace: args.namespace,
    });

    let sawFirstTool = false;
    let firstToolTurnCount: number | null = null;

    for await (const event of result.events) {
      if (event.type === "TOKEN") {
        const payload = event.payload as {
          token?: string;
          isReasoning?: boolean;
        };
        const token = payload.token ?? "";
        if (!payload.isReasoning) {
          raw.visibleText += token;
          if (!sawFirstTool) raw.visibleBeforeFirstTool += token;
        }
      }

      if (event.type === "LLM_RESULT") {
        const payload = event.payload as Record<string, unknown>;
        if (payload.status === "failed") {
          raw.error = typeof payload.answer === "string"
            ? payload.answer
            : "LLM result failed";
        }
        const toolCalls = Array.isArray(payload.toolCalls)
          ? payload.toolCalls as Array<Record<string, unknown>>
          : [];
        if (firstToolTurnCount === null && toolCalls.length > 0) {
          firstToolTurnCount = toolCalls.length;
        }
        raw.llmResults.push({
          status: payload.status,
          finishReason: payload.finishReason,
          answer: payload.answer,
          error: payload.error,
          provider: payload.provider,
          model: payload.model,
          toolCalls: payload.toolCalls,
        });
      }

      if (event.type === "TOOL_CALL") {
        sawFirstTool = true;
        const payload = event.payload as { toolCall?: ToolInvocation };
        const call = payload.toolCall;
        raw.toolCalls.push({
          id: call?.id ?? null,
          name: call?.tool?.id ?? "",
          args: normalizeArgs(call?.args),
          batchIndex: (call as unknown as { batchIndex?: number | null })
            ?.batchIndex ?? null,
          batchSize: (call as unknown as { batchSize?: number | null })
            ?.batchSize ?? null,
        });
      }

      if (event.type === "NEW_MESSAGE") {
        const payload = event.payload as {
          sender?: { type?: string };
          metadata?: { toolCalls?: unknown[] };
        };
        if (payload.sender?.type === "tool") {
          raw.toolResults.push({
            toolCalls: payload.metadata?.toolCalls ?? [],
          });
        }
      }
    }

    await result.done;
    raw.grader = gradeRun(args.testCase, raw, firstToolTurnCount);
  } catch (error) {
    raw.error = error instanceof Error ? error.message : String(error);
    raw.grader = {
      ...emptyGrader(),
      score: 0,
      failures: [`run error: ${raw.error}`],
    };
  }

  return raw;
}

function gradeRun(
  testCase: EvalCase,
  raw: {
    visibleBeforeFirstTool: string;
    visibleText: string;
    llmResults: Array<Record<string, unknown>>;
    toolCalls: ToolCallRecord[];
    error: string | null;
  },
  firstToolTurnCount: number | null,
): Grader {
  const failures: string[] = [];
  if (raw.error) {
    return {
      ...emptyGrader(),
      score: 0,
      failures: [`provider/run error: ${raw.error}`],
    };
  }

  const textForProtocolScan = [
    raw.visibleBeforeFirstTool,
    raw.visibleText,
    ...raw.llmResults.map((result) => String(result.answer ?? "")),
  ].join("\n");
  const actualTools = raw.toolCalls.map((call) => call.name);
  const expected = testCase.expectedTools;

  const parseValid = !raw.error &&
    (expected.length === 0 || raw.toolCalls.length > 0);
  if (!parseValid) failures.push("expected tool calls were not parsed");

  const toolNameValid = raw.toolCalls.every((call) =>
    ALL_TOOL_NAMES.includes(call.name)
  );
  if (!toolNameValid) failures.push("unknown tool name emitted");

  const toolChoiceCorrect = multisetEquals(actualTools, expected);
  if (!toolChoiceCorrect) {
    failures.push(
      `tool choice mismatch expected=[${expected.join(",")}] actual=[${
        actualTools.join(",")
      }]`,
    );
  }

  const firstToolTurnCorrect =
    testCase.expectFirstToolTurnCount === undefined ||
    firstToolTurnCount === testCase.expectFirstToolTurnCount;
  if (!firstToolTurnCorrect) {
    failures.push(
      `first tool turn count expected=${testCase.expectFirstToolTurnCount} actual=${firstToolTurnCount}`,
    );
  }

  const noNativeSyntax =
    !/<\/?(?:[a-z0-9_]+:)?(?:tool_call|function_call|function_calls|invoke|parameter|tool_use|tool)\b/i
      .test(textForProtocolScan) &&
    !/\b(?:function_call|tool_use|tool_calls)\b/i.test(raw.visibleText);
  if (!noNativeSyntax) failures.push("visible/native tool syntax leaked");

  const noFakeResults =
    !/<\/?(?:tool_results|tool_result|result|continue_after_tool_results|target_ids)\b/i
      .test(textForProtocolScan);
  if (!noFakeResults) failures.push("fake tool result syntax emitted");

  const noLowValueVisibleText = expected.length === 0 ||
    testCase.allowVisibleBeforeTool ||
    !isLowValueToolPreamble(raw.visibleBeforeFirstTool);
  if (!noLowValueVisibleText) {
    failures.push(
      `low-value visible text before first tool call: ${
        JSON.stringify(raw.visibleBeforeFirstTool.trim())
      }`,
    );
  }

  const noDuplicateVisibleAnswer = !hasDuplicateVisibleAnswer(
    raw.visibleBeforeFirstTool,
    raw.visibleText,
    expected.length > 0,
  );
  if (!noDuplicateVisibleAnswer) {
    failures.push(
      `duplicated visible answer around tool call: ${
        JSON.stringify(raw.visibleBeforeFirstTool.trim())
      }`,
    );
  }

  const finalAnswerCorrect = (testCase.finalIncludes ?? []).every((needle) =>
    raw.visibleText.toLowerCase().includes(needle.toLowerCase())
  );
  if (!finalAnswerCorrect) {
    failures.push(
      `final answer missing expected text: ${
        (testCase.finalIncludes ?? []).join(", ")
      }`,
    );
  }

  const checks = [
    ["parseValid", parseValid, 15],
    ["toolNameValid", toolNameValid, 10],
    ["toolChoiceCorrect", toolChoiceCorrect, 20],
    ["firstToolTurnCorrect", firstToolTurnCorrect, 10],
    ["noNativeSyntax", noNativeSyntax, 10],
    ["noFakeResults", noFakeResults, 15],
    ["noLowValueVisibleText", noLowValueVisibleText, 10],
    ["noDuplicateVisibleAnswer", noDuplicateVisibleAnswer, 5],
    ["finalAnswerCorrect", finalAnswerCorrect, 5],
  ] as const;
  const score = checks.reduce(
    (sum, [, pass, weight]) => sum + (pass ? weight : 0),
    0,
  );

  return {
    parseValid,
    toolNameValid,
    toolChoiceCorrect,
    firstToolTurnCorrect,
    noNativeSyntax,
    noFakeResults,
    noLowValueVisibleText,
    noDuplicateVisibleAnswer,
    finalAnswerCorrect,
    score,
    failures,
  };
}

async function writeSummary(rows: RunRecord[]): Promise<void> {
  const byVariant = groupBy(rows, (row) => row.variant);
  const byProviderVariant = groupBy(
    rows,
    (row) => `${row.provider} / ${row.variant}`,
  );
  const lines: string[] = [
    "# Tool Prompt Eval Summary",
    "",
    `Created: ${new Date().toISOString()}`,
    `Runs: ${rows.length}`,
    "",
    "## By Variant",
    "",
    "| Variant | Runs | Pass % | Avg Score |",
    "| --- | ---: | ---: | ---: |",
  ];

  for (const [variant, group] of byVariant) {
    lines.push(summaryRow(variant, group));
  }

  lines.push(
    "",
    "## By Provider / Variant",
    "",
    "| Provider / Variant | Runs | Pass % | Avg Score |",
    "| --- | ---: | ---: | ---: |",
  );
  for (const [key, group] of byProviderVariant) {
    lines.push(summaryRow(key, group));
  }

  const failures = rows.filter((row) => row.status !== "passed");
  lines.push("", "## Failures", "");
  if (failures.length === 0) {
    lines.push("No failures.");
  } else {
    for (const row of failures) {
      lines.push(
        `- ${row.provider} / ${row.variant} / ${row.caseId} / run ${row.repeat}: ${
          row.grader.failures.join("; ")
        } (${row.rawPath})`,
      );
    }
  }

  await Deno.writeTextFile(join(OUT_DIR, "summary.md"), lines.join("\n"));
  await Deno.writeTextFile(
    join(OUT_DIR, "failures.md"),
    failures.length === 0 ? "No failures.\n" : failures.map((row) =>
      [
        `## ${row.provider} / ${row.variant} / ${row.caseId} / run ${row.repeat}`,
        "",
        `Score: ${row.score}`,
        "",
        row.grader.failures.map((failure) => `- ${failure}`).join("\n"),
        "",
        `Raw: ${row.rawPath}`,
        "",
      ].join("\n")
    ).join("\n"),
  );
}

function summaryRow(label: string, rows: RunRecord[]): string {
  const passCount = rows.filter((row) => row.status === "passed").length;
  const passPct = rows.length > 0
    ? Math.round((passCount / rows.length) * 100)
    : 0;
  const avgScore = rows.length > 0
    ? Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length)
    : 0;
  return `| ${label} | ${rows.length} | ${passPct}% | ${avgScore} |`;
}

function providerSpecs(): ProviderSpec[] {
  const selected = parseList("TOOL_PROMPT_EVAL_PROVIDERS", []);
  const specs: ProviderSpec[] = [
    {
      provider: "openai" as const,
      model: Deno.env.get("TOOL_PROMPT_EVAL_OPENAI_MODEL") ?? "gpt-5.4",
      apiKey: pickEnv(["OPENAI_KEY", "OPENAI_API_KEY", "DEFAULT_OPENAI_KEY"]),
      openaiApi: readOpenAIApiMode(),
    },
    {
      provider: "anthropic" as const,
      model: Deno.env.get("TOOL_PROMPT_EVAL_ANTHROPIC_MODEL") ??
        "claude-sonnet-4-6",
      apiKey: pickEnv(["ANTHROPIC_KEY", "ANTHROPIC_API_KEY"]),
    },
    {
      provider: "gemini" as const,
      model: Deno.env.get("TOOL_PROMPT_EVAL_GEMINI_MODEL") ??
        "gemini-3.5-flash",
      apiKey: pickEnv(["GEMINI_KEY", "GEMINI_API_KEY"]),
    },
    {
      provider: "minimax" as const,
      model: Deno.env.get("TOOL_PROMPT_EVAL_MINIMAX_MODEL") ?? "MiniMax-M3",
      apiKey: pickEnv(["MINIMAX_KEY", "MINIMAX_API_KEY"]),
    },
  ].filter((spec) => spec.apiKey.length > 0);

  return selected.length === 0
    ? specs
    : specs.filter((spec) => selected.includes(spec.provider));
}

function pickEnv(names: string[]): string {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value) return value;
  }
  return "";
}

function readOpenAIApiMode(): "responses" | "chat_completions" {
  return Deno.env.get("TOOL_PROMPT_EVAL_OPENAI_API") === "chat_completions"
    ? "chat_completions"
    : "responses";
}

function parseList(name: string, fallback: string[]): string[] {
  const value = Deno.env.get(name);
  if (!value) return fallback;
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(args) ? args : {};
}

function normalizeVisibleText(value: string): string {
  return value.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ")
    .trim();
}

function isLowValueToolPreamble(value: string): boolean {
  const text = normalizeVisibleText(value);
  if (!text) return false;
  return [
    /^sure\b.*\b(running|doing|checking|calling|using)\b/,
    /^i('|’)ll\s+(call|use|run|make|record|create|preview|check|fetch)\b/,
    /^i will\s+(call|use|run|make|record|create|preview|check|fetch)\b/,
    /^recording (it|the .*) now\.?$/,
    /^calling .* tool/,
    /^using .* tool/,
  ].some((pattern) => pattern.test(text));
}

function hasDuplicateVisibleAnswer(
  beforeFirstTool: string,
  visibleText: string,
  expectedToolCall: boolean,
): boolean {
  if (!expectedToolCall) return false;
  const before = normalizeVisibleText(beforeFirstTool);
  if (before.length < 2) return false;
  const all = normalizeVisibleText(visibleText);
  if (!all.startsWith(before)) return false;
  const after = all.slice(before.length).trim();
  return after.includes(before);
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function multisetEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const aSorted = [...a].sort();
  const bSorted = [...b].sort();
  return aSorted.every((value, index) => value === bSorted[index]);
}

function groupBy<T>(
  values: T[],
  keyFn: (value: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFn(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

function emptyGrader(): Grader {
  return {
    parseValid: false,
    toolNameValid: false,
    toolChoiceCorrect: false,
    firstToolTurnCorrect: false,
    noNativeSyntax: false,
    noFakeResults: false,
    noLowValueVisibleText: false,
    noDuplicateVisibleAnswer: false,
    finalAnswerCorrect: false,
    score: 0,
    failures: [],
  };
}
