import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { defineAction } from "@copilotz/copilotz/actions";
import { corePlugin, defineAgent } from "@copilotz/copilotz/core";
import {
  createLlmAdapter,
  type LlmAdapterCallInput,
  type LlmAdapterResult,
} from "@copilotz/copilotz/llm";
import { definePlugin } from "@copilotz/copilotz/plugins";
import { defineTool } from "@copilotz/copilotz/tools";
import { createCopilotzApplication } from "../../../../runtime/application/application.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { createTestDomainContext } from "../../internal/testing/context.ts";
import { runGoal } from "./index.ts";

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

async function fixture() {
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
    resources: {
      agents: {
        target: defineAgent({
          id: "target",
          name: "Target",
          role: "system under test",
          instructions: "ACTIVE_AGENT=target",
          models: { generate: ["scripted"] },
          capabilities: { tools: ["goal_probe"] },
        }),
        lead: defineAgent({
          id: "lead",
          name: "Lead",
          role: "goal driver",
          instructions: "ACTIVE_AGENT=lead",
          models: { generate: ["scripted"] },
        }),
      },
      models: {
        scripted: { adapter: "scripted", model: "fixture-model" },
      },
      tools: {
        goal_probe: defineTool("goal_probe", probeAction, {
          name: "Goal probe",
          description: "Inspects one Goal input.",
        }),
      },
    },
    adapters: { llm: { scripted: adapter } },
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
    counts: () => ({ targetCalls, leadCalls, toolCalls }),
  };
}

Deno.test("runGoal alternates settled sends and relays canonical Message content", async () => {
  const run = await fixture();
  try {
    let streamOutputs = 0;
    const handle = runGoal(run.application, {
      id: "booking-goal",
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
      content: "Start the booking.",
      maxTurns: 3,
      decide({ turn }) {
        return turn === 2
          ? { status: "completed", reason: "booking-confirmed" }
          : "continue";
      },
      onOutput(output) {
        if (output.type === "stream.output") streamOutputs += 1;
      },
    });
    const collected = (async () => {
      const events = [];
      for await (const event of handle.events) events.push(event);
      return events;
    })();
    const result = await handle.done;
    const events = await collected;

    assertEquals(result.status, "completed");
    assertEquals(result.reason, "booking-confirmed");
    assertEquals(result.turns, 2);
    assertEquals(result.transcript.map((item) => item.phase), [
      "target",
      "lead",
      "target",
    ]);
    assertEquals(result.metrics.targetTurns, 2);
    assertEquals(result.metrics.leadTurns, 1);
    assertEquals(run.counts(), {
      targetCalls: 3,
      leadCalls: 1,
      toolCalls: 1,
    });
    assertEquals(run.calls.map((item) => item.agent), [
      "target",
      "target",
      "lead",
      "target",
    ]);
    assertEquals(run.calls[2]?.input, "Which passenger should I use?");
    assertEquals(run.calls[3]?.input, "Use passenger Alice.");
    const final = result.transcript.at(-1);
    assertExists(final);
    assertEquals(final.content.length, 2);
    assertEquals(Object.isFrozen(final.content), true);
    assertEquals(Object.isFrozen(final.content[0]), true);
    const attachment = final.content[1];
    assertExists(attachment);
    assertEquals("bytes" in attachment, false);
    assertEquals(streamOutputs, 0);
    assertEquals(
      events.filter((event) => event.type === "goal.turn.completed").length,
      3,
    );
    assertEquals(events.at(-1)?.type, "goal.finished");
  } finally {
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("runGoal validates its minimal local contract synchronously", () => {
  const application = {
    send() {
      return Promise.reject(new Error("not reached"));
    },
    observe() {
      return new ReadableStream();
    },
    close() {
      return Promise.resolve();
    },
  };
  const valid = {
    target: { thread: "target", participant: "user", recipient: "agent" },
    lead: { thread: "lead", participant: "proxy", recipient: "lead-agent" },
    content: "test",
  } as const;
  assertThrows(
    () => runGoal(application, { ...valid, maxTurns: 0 }),
    TypeError,
    "maxTurns",
  );
  assertThrows(
    () =>
      runGoal(application, {
        ...valid,
        target: { ...valid.target, recipient: " " },
      }),
    TypeError,
    "recipient",
  );
});

Deno.test("runGoal stops at maxTurns without starting an unnecessary lead turn", async () => {
  const run = await fixture();
  try {
    const result = await runGoal(run.application, {
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
      content: "Run one complete target turn.",
      maxTurns: 1,
    }).done;
    assertEquals(result.status, "stopped");
    assertEquals(result.reason, "Maximum turns reached (1).");
    assertEquals(result.transcript.map((item) => item.phase), ["target"]);
    assertEquals(run.counts(), {
      targetCalls: 2,
      leadCalls: 0,
      toolCalls: 1,
    });
  } finally {
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("runGoal cancellation cancels the active send and starts no next turn", async () => {
  let sends = 0;
  let cancels = 0;
  let closeOutputs!: () => void;
  let finishSend!: () => void;
  const application = {
    send() {
      sends += 1;
      const done = new Promise<void>((resolve) => finishSend = resolve);
      return Promise.resolve(Object.freeze({
        eventId: "active-input",
        correlationId: "active-correlation",
        outputs: new ReadableStream({
          start(controller) {
            closeOutputs = () => controller.close();
          },
        }),
        done,
        cancel() {
          cancels += 1;
          closeOutputs();
          finishSend();
          return Promise.resolve();
        },
      }));
    },
    observe() {
      return new ReadableStream();
    },
    close() {
      return Promise.resolve();
    },
  };
  const handle = runGoal(application, {
    target: { thread: "target", participant: "user", recipient: "agent" },
    lead: { thread: "lead", participant: "proxy", recipient: "lead-agent" },
    content: "test",
  });
  await Promise.resolve();
  await handle.cancel("user-cancelled");
  const result = await handle.done;
  assertEquals(result.status, "cancelled");
  assertEquals(result.reason, "user-cancelled");
  assertEquals(sends, 1);
  assertEquals(cancels >= 1, true);

  let preAbortedSends = 0;
  const controller = new AbortController();
  controller.abort("");
  const preAborted = await runGoal({
    ...application,
    send() {
      preAbortedSends += 1;
      return application.send();
    },
  }, {
    target: { thread: "target", participant: "user", recipient: "agent" },
    lead: { thread: "lead", participant: "proxy", recipient: "lead-agent" },
    content: "test",
    signal: controller.signal,
  }).done;
  assertEquals(preAborted.status, "cancelled");
  assertEquals(preAborted.reason, "Goal aborted.");
  assertEquals(preAbortedSends, 0);
});

Deno.test("runGoal cancellation during decide wins before the lead turn", async () => {
  const run = await fixture();
  let enterDecision!: () => void;
  let releaseDecision!: () => void;
  const entered = new Promise<void>((resolve) => enterDecision = resolve);
  const released = new Promise<void>((resolve) => releaseDecision = resolve);
  try {
    const handle = runGoal(run.application, {
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
      content: "Wait before deciding.",
      maxTurns: 2,
      async decide() {
        enterDecision();
        await released;
        return "continue" as const;
      },
    });
    await entered;
    await handle.cancel("cancelled-during-decision");
    releaseDecision();
    const result = await handle.done;
    assertEquals(result.status, "cancelled");
    assertEquals(result.reason, "cancelled-during-decision");
    assertEquals(run.counts(), {
      targetCalls: 2,
      leadCalls: 0,
      toolCalls: 1,
    });
  } finally {
    releaseDecision?.();
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("runGoal converts a settled turn without an Agent reply into failure", async () => {
  const application = {
    send() {
      return Promise.resolve(Object.freeze({
        eventId: "input-message",
        correlationId: "missing-reply",
        outputs: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        done: Promise.resolve(),
        cancel() {
          return Promise.resolve();
        },
      }));
    },
    observe() {
      return new ReadableStream();
    },
    close() {
      return Promise.resolve();
    },
  };
  const handle = runGoal(application, {
    target: { thread: "target", participant: "user", recipient: "agent" },
    lead: { thread: "lead", participant: "proxy", recipient: "lead-agent" },
    content: "test",
    maxTurns: 1,
  });
  const result = await handle.done;
  assertEquals(result.status, "failed");
  assertEquals(
    result.reason?.includes("did not project its input Message"),
    true,
  );
  assertThrows(
    () =>
      runGoal(null as never, {
        target: { thread: "target", participant: "user", recipient: "agent" },
        lead: { thread: "lead", participant: "proxy", recipient: "lead-agent" },
        content: "test",
      }),
    TypeError,
  );
});
