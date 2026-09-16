import type { GoalConversationAdapter } from "./index.ts";
import type { CoreToolProcessorContext } from "../../shared/runtime-context.ts";
import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { defineAction } from "@copilotz/copilotz/actions";
import { corePlugin, defineAgent } from "@copilotz/copilotz/core";
import {
  createLlmAdapter,
  type LlmAdapterCallInput,
  type LlmAdapterResult,
} from "@copilotz/copilotz/llm";
import { definePlugin, defineProcessor } from "@copilotz/copilotz/plugins";
import { defineTool } from "@copilotz/copilotz/core";
import { createCopilotzApplication } from "../../../../runtime/application/application.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { createTestDomainContext } from "../../shared/testing/context.ts";
import { type GoalResult, runGoalAction, type RunGoalInput } from "./index.ts";
import type { GoalPolicy } from "../../resources/goals/default/index.ts";

const NAMESPACE = "goal-runner-test";
const SCHEMA = "goal_runner_test";

function result(
  content: LlmAdapterResult["content"],
  toolCalls?: LlmAdapterResult["toolCalls"],
): LlmAdapterResult {
  return Object.freeze({
    content,
    ...(toolCalls ? { toolCalls } : {}),
    attempts: Object.freeze([{ status: "completed" as const }]),
    finishReason: toolCalls ? "tool_calls" : "stop",
  });
}

function textFromLastUser(input: LlmAdapterCallInput): string {
  const latest = [...input.request.messages].reverse().find((item) =>
    item.role === "user"
  );
  return latest?.content.flatMap((part) =>
    part.type === "text" && "text" in part ? [part.text] : []
  ).join("\n") ?? "";
}

async function fixture(
  policy: GoalPolicy = {
    maxTurns: 3,
    decide: ({ turn }) =>
      turn === 2
        ? { status: "completed", reason: "booking-confirmed" }
        : "continue",
  },
  conversation?: GoalConversationAdapter,
) {
  const db = await createTestDatabase({ url: ":memory:" });
  const calls: Readonly<{ agent: string; input: string }>[] = [];
  let targetCalls = 0;
  let leadCalls = 0;
  let toolCalls = 0;
  const adapter = createLlmAdapter({
    call(input) {
      const agent = input.request.instructions?.includes("ACTIVE_AGENT=target")
        ? "target"
        : "lead";
      calls.push(Object.freeze({ agent, input: textFromLastUser(input) }));
      const output = Promise.resolve().then(() => {
        if (agent === "target") {
          targetCalls += 1;
          if (targetCalls === 1) {
            return result("I will inspect the request.", [{
              id: "goal-probe-call",
              action: "goal_probe",
              input: { value: "first-turn" },
            }]);
          }
          if (targetCalls === 2) return result("Which passenger should I use?");
          return result([
            { type: "text", text: "Booking confirmed for Alice." },
            {
              type: "image",
              bytes: new Uint8Array([1, 2, 3]),
              mediaType: "image/png",
              role: "attachment",
            },
          ]);
        }
        leadCalls += 1;
        return result("Use passenger Alice.");
      });
      return Object.freeze({
        frames: new ReadableStream({
          async start(controller) {
            try {
              await output;
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
        }),
        result: output,
      });
    },
  });
  const probeAction = defineAction({
    id: "test.goal.probe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    } as const,
    execute(input: Readonly<{ value: string }>) {
      toolCalls += 1;
      return { inspected: input.value };
    },
  });
  const fixturePlugin = definePlugin({
    id: "test.goal-runner",
    version: "1.0.0",
    actions: { goal_probe: probeAction },
    processors: {
      goalRequest: defineProcessor<CoreToolProcessorContext>({
        id: "test.goal.request",
        on: [{ eventType: "test.goal.request" }],
        async handle(_event, context) {
          await context.actions.runGoal(input);
        },
      }),
    },
    resources: {
      goals: { default: policy },
      agents: {
        target: defineAgent({
          id: "target",
          name: "Target",
          role: "system under test",
          instructions: "ACTIVE_AGENT=target",
          models: {
            generate: [{ connection: "scripted", model: "fixture-model" }],
          },
          capabilities: { tools: ["goal_probe"] },
        }),
        lead: defineAgent({
          id: "lead",
          name: "Lead",
          role: "goal driver",
          instructions: "ACTIVE_AGENT=lead",
          models: {
            generate: [{ connection: "scripted", model: "fixture-model" }],
          },
        }),
      },
      llmConnections: {
        scripted: { adapter: "scripted" },
      },
      tools: {
        goal_probe: defineTool("goal_probe", probeAction, {
          name: "Goal probe",
          description: "Inspects one Goal input.",
        }),
      },
    },
    adapters: {
      llm: { scripted: adapter },
      conversation: {
        default: conversation ?? {
          send: (input: Parameters<typeof application.send>[0]) =>
            application.send(input),
        },
      },
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: SCHEMA,
    plugins: [corePlugin, fixturePlugin],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  const domain = createTestDomainContext(application, NAMESPACE);
  await domain.actions.createThread({
    id: "target-thread",
    participants: [{
      id: "target-user",
      externalId: "target-user",
      participantType: "human",
    }, {
      id: "target-participant",
      externalId: "target",
      participantType: "agent",
      agentId: "target",
    }],
  });
  await domain.actions.createThread({
    id: "lead-thread",
    participants: [{
      id: "lead-proxy",
      externalId: "lead-proxy",
      participantType: "human",
    }, {
      id: "lead-participant",
      externalId: "lead",
      participantType: "agent",
      agentId: "lead",
    }],
  });
  return {
    application,
    db,
    calls,
    domain,
    counts: () => ({ targetCalls, leadCalls, toolCalls }),
  };
}

const input: RunGoalInput = {
  target: {
    thread: "target-thread",
    participant: "target-user",
    recipient: "target-participant",
  },
  lead: {
    thread: "lead-thread",
    participant: "lead-proxy",
    recipient: "lead-participant",
  },
  content: "Start booking",
};
Deno.test("Goal Action uses final policy/Adapter context and relays settled tool turns", async () => {
  const f = await fixture();
  try {
    const result = await f.domain.actions.runGoal(input) as GoalResult;
    assertEquals(result.status, "completed");
    assertEquals(result.turns, 2);
    assertEquals(result.transcript.map((x) => x.phase), [
      "target",
      "lead",
      "target",
    ]);
    assertEquals(f.counts(), { targetCalls: 3, leadCalls: 1, toolCalls: 1 });
    assertEquals(result.reason, "booking-confirmed");
  } finally {
    await f.application.shutdown();
    await f.db.close();
  }
});
Deno.test("Goal Action stops at its Resource limit without an unnecessary lead turn", async () => {
  const f = await fixture({ maxTurns: 1 });
  try {
    const result = await f.domain.actions.runGoal(input) as GoalResult;
    assertEquals(result.status, "stopped");
    assertEquals(result.turns, 1);
    assertEquals(f.counts().leadCalls, 0);
  } finally {
    await f.application.shutdown();
    await f.db.close();
  }
});
Deno.test("Goal Action cancellation during a policy decision prevents the next turn", async () => {
  const controller = new AbortController();
  const f = await fixture({
    maxTurns: 3,
    decide() {
      controller.abort(new Error("cancel-goal"));
      return "continue";
    },
  });
  try {
    await assertRejects(
      () => f.domain.actions.runGoal(input, { signal: controller.signal }),
      Error,
      "cancel-goal",
    );
    assertEquals(f.counts().leadCalls, 0);
  } finally {
    await f.application.shutdown();
    await f.db.close();
  }
});
Deno.test("Goal Action rejects invalid configuration through its normal caller", async () => {
  const f = await fixture();
  try {
    await assertRejects(() =>
      f.domain.actions.runGoal({ ...input, maxTurns: 0 })
    );
    await assertRejects(
      () => f.domain.actions.runGoal({ ...input, policy: "missing" }),
      Error,
      "policy",
    );
  } finally {
    await f.application.shutdown();
    await f.db.close();
  }
});

Deno.test("Goal Action runs within engine dispatch and publishes ordinary progress/terminal Events", async () => {
  const f = await fixture({ maxTurns: 1 });
  try {
    const handle = await f.application.send({ type: "test.goal.request" });
    const types: string[] = [];
    for await (const event of handle.outputs) types.push(event.type);
    await handle.done;
    assertEquals(types.includes("copilotz.core.goal.run.progress"), true);
    assertEquals(types.includes("copilotz.core.goal.run.completed"), true);
  } finally {
    await f.application.shutdown();
    await f.db.close();
  }
});

Deno.test("Goal Action cancels an active Adapter send and starts no next turn", async () => {
  let began!: () => void;
  const started = new Promise<void>((resolve) => began = resolve);
  let finish!: () => void;
  let close!: () => void;
  let sends = 0, cancels = 0;
  const conversation: GoalConversationAdapter = {
    send() {
      sends++;
      began();
      return Promise.resolve({
        eventId: "input",
        correlationId: "turn",
        outputs: new ReadableStream({
          start(controller) {
            close = () => controller.close();
          },
        }),
        done: new Promise<void>((resolve) => finish = resolve),
        cancel() {
          cancels++;
          close();
          finish();
          return Promise.resolve();
        },
      });
    },
  };
  const f = await fixture({ maxTurns: 2 }, conversation);
  const controller = new AbortController();
  try {
    const pending = f.domain.actions.runGoal(input, {
      signal: controller.signal,
    });
    await started;
    controller.abort(new Error("cancel-active-goal"));
    await assertRejects(() => pending, Error, "cancel-active-goal");
    assertEquals(sends, 1);
    assertEquals(cancels >= 1, true);
  } finally {
    await f.application.shutdown();
    await f.db.close();
  }
});
Deno.test("Goal Action fails normally when its Adapter settles without a projected reply", async () => {
  const conversation: GoalConversationAdapter = {
    send() {
      return Promise.resolve({
        eventId: "input",
        correlationId: "turn",
        outputs: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        done: Promise.resolve(),
        cancel() {
          return Promise.resolve();
        },
      });
    },
  };
  const f = await fixture({ maxTurns: 1 }, conversation);
  try {
    await assertRejects(
      () => f.domain.actions.runGoal(input),
      Error,
      "did not project its input Message",
    );
  } finally {
    await f.application.shutdown();
    await f.db.close();
  }
});
