import { assert, assertEquals } from "@std/assert";
import { generateToolSystemPrompt, TOOL_PROTOCOL } from "./tool-prompt.ts";
import { parseToolCallsFromResponse } from "./wire-parse.ts";
import { estimateTextTokens } from "../authoring/token-estimation/index.ts";

Deno.test("canonical tool protocol examples parse as single, sequential, jq, parallel and mixed calls", () => {
  const examples = [
    ...TOOL_PROTOCOL.matchAll(/<tool_calls>\n[\s\S]*?<\/tool_calls>/g),
  ];
  assertEquals(examples.length, 5);
  const shapes = examples.map(([example]) =>
    parseToolCallsFromResponse(example, [
      "get_location",
      "get_weather",
      "save_note",
    ])
      .toolCalls.map((call) =>
        call.pipeline?.stages.map((stage) => stage.type) ?? ["tool"]
      )
  );
  assertEquals(shapes, [
    [["tool"]],
    [["tool", "tool"]],
    [["tool", "jq", "tool"]],
    [["tool"], ["tool"]],
    [["tool", "tool", "jq", "tool"], ["tool", "tool"]],
  ]);
  assert(estimateTextTokens(TOOL_PROTOCOL) < 800);
});

Deno.test("one tool protocol preserves text-only, tool-only and mixed replies", () => {
  const [example] =
    [...TOOL_PROTOCOL.matchAll(/<tool_calls>\n[\s\S]*?<\/tool_calls>/g)][0];
  assertEquals(parseToolCallsFromResponse("It is sunny.").toolCalls, []);
  assertEquals(parseToolCallsFromResponse(example).cleanResponse.trim(), "");
  const mixed = parseToolCallsFromResponse(
    `A useful explanation.\n${example}\nMore context.`,
  );
  assertEquals(mixed.toolCalls.length, 1);
  assert(mixed.cleanResponse.includes("A useful explanation."));
  assert(mixed.cleanResponse.includes("More context."));
});

Deno.test("tool catalog follows the single protocol without reasoning instructions", () => {
  const prompt = generateToolSystemPrompt([{
    type: "function",
    function: {
      name: "lookup",
      description: "Look up one record.",
      inputTypes: "{ id: string }",
    },
  }]);
  assert(prompt.startsWith(TOOL_PROTOCOL));
  assert(prompt.includes("### lookup"));
  assertEquals(prompt.includes("<think>"), false);
});

Deno.test("published examples execute with the runtime jq and argument merge", async () => {
  const { evaluateCoreJq, mergePipelineArguments } = await import(
    "../../core/shared/jq.ts"
  );
  const examples = [
    ...TOOL_PROTOCOL.matchAll(/<tool_calls>\n[\s\S]*?<\/tool_calls>/g),
  ];
  const saved: Record<string, unknown>[] = [];
  for (const [example] of examples) {
    const calls = parseToolCallsFromResponse(example).toolCalls;
    await Promise.all(calls.map(async (call) => {
      const stages = call.pipeline?.stages ??
        [{ type: "tool" as const, ...call }];
      let result: unknown;
      for (const stage of stages) {
        if (stage.type === "jq") {
          result = await evaluateCoreJq(result, stage.filter);
          continue;
        }
        const explicit = JSON.parse(stage.args);
        const args = result === undefined
          ? explicit
          : mergePipelineArguments(result, explicit);
        switch (stage.tool.id) {
          case "get_location":
            result = args.city === "London"
              ? { latitude: 51.51, longitude: -0.13 }
              : { latitude: 35.68, longitude: 139.69 };
            break;
          case "get_weather":
            assert(
              typeof args.latitude === "number" &&
                typeof args.longitude === "number",
            );
            assertEquals(args.units, "celsius");
            result = { temperature: 18, condition: "sunny" };
            break;
          case "save_note":
            saved.push(args);
            result = { saved: true };
            break;
          default:
            throw new Error("Unexpected example tool.");
        }
      }
    }));
  }
  assertEquals(saved, [{ title: "London weather", text: "18 C, sunny" }, {
    title: "London weather",
    text: "18 C, sunny",
  }]);
  assertEquals(
    mergePipelineArguments({
      config: { units: "fahrenheit", precision: 1 },
      labels: ["old"],
    }, { config: { units: "celsius" }, labels: ["new"] }),
    { config: { units: "celsius", precision: 1 }, labels: ["new"] },
  );
});
