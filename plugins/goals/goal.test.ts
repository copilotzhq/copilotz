import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { type ActionContext, defineAction } from "@copilotz/copilotz/actions";
import { createCopilotzApplication } from "../../runtime/application/application.ts";
import {
  type AgentResource,
  coreToolPlanMetadata,
  defineAgent,
  defineCoreLlmCallMetadata,
  workflowMetadata,
} from "@copilotz/copilotz/core";
import type {
  LlmAdapter,
  LlmAdapterCallInput,
  LlmAdapterResult,
} from "@copilotz/copilotz/llm";
import { definePlugin, defineProcessor } from "@copilotz/copilotz/plugins";
import { defineTool } from "@copilotz/copilotz/tools";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../runtime/testing/ominipg.ts";
import {
  projectActionEvents,
  projectMessages,
} from "../core/testing/projections.ts";
import {
  asGoalRecord,
  cancelGoal,
  createGoalsPlugin,
  defineGoal,
  goalResult,
  startGoal,
} from "./index.ts";
import type {
  GoalEvaluateActionInput,
  GoalRecord,
  GoalResource,
  GoalStopActionInput,
} from "./types.ts";

const NAMESPACE = "goal-tenant";
const SCHEMA = "goal_native_plugin";

function adapterFrom(
  handler: (
    input: LlmAdapterCallInput,
  ) => LlmAdapterResult | Promise<LlmAdapterResult>,
): LlmAdapter {
  return Object.freeze({
    call(input) {
      const result = Promise.resolve().then(() => handler(input));
      return Object.freeze({
        frames: new ReadableStream({
          async start(controller) {
            try {
              await result;
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
        }),
        result,
      });
    },
  });
}

function activeAgent(input: LlmAdapterCallInput): string {
  const match = /ACTIVE_AGENT=([a-z0-9-]+)/.exec(
    input.request.instructions ?? "",
  );
  if (!match) throw new Error("Fixture prompt did not identify an Agent.");
  return match[1];
}

function result(
  content: LlmAdapterResult["content"],
  reasoning?: LlmAdapterResult["reasoning"],
): LlmAdapterResult {
  return Object.freeze({
    content,
    ...(reasoning ? { reasoning } : {}),
    attempts: Object.freeze([{ status: "completed" as const }]),
    finishReason: "stop",
  });
}

function agent(id: string, name: string, withTool = false): AgentResource {
  return defineAgent({
    id,
    name,
    role: "goal fixture",
    instructions: `ACTIVE_AGENT=${id}`,
    models: { generate: "goalModel" },
    ...(withTool ? { capabilities: { tools: ["fixture_tool"] } } : {}),
  });
}

type Counters = {
  target: number;
  lead: number;
  judge: number;
  stop: number;
  evaluate: number;
  tool: number;
};

type FixtureOptions = Readonly<{
  db?: TestDatabase;
  schema?: string;
  withJudge?: boolean;
  withEvaluate?: boolean;
  withTool?: boolean;
  delayGoalToolFacts?: Promise<void>;
  failConfiguredStopReceiptOnce?: { failed: boolean };
  hideStopActionFromGoalProcessor?: boolean;
  hideEvaluateActionFromGoalProcessor?: boolean;
  stopActionAlias?: string;
  maxTurns?: number;
  retryBaseMs?: number;
  retryRandom?: () => number;
  handler?: (input: LlmAdapterCallInput, counters: Counters) =>
    | LlmAdapterResult
    | Promise<LlmAdapterResult>;
  counters?: Counters;
  stop?: (
    input: GoalStopActionInput,
    counters: Counters,
    context: ActionContext,
  ) => unknown | Promise<unknown>;
  evaluate?: (
    input: GoalEvaluateActionInput,
    context: ActionContext,
    counters: Counters,
  ) => unknown | Promise<unknown>;
}>;

async function fixture(input: FixtureOptions = {}) {
  const db = input.db ?? await createTestDatabase({ url: ":memory:" });
  const counters = input.counters ?? {
    target: 0,
    lead: 0,
    judge: 0,
    stop: 0,
    evaluate: 0,
    tool: 0,
  };
  const toolAction = defineAction({
    id: "fixture.goal.tool",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    } as const,
    execute(value: Readonly<{ value: string }>) {
      counters.tool += 1;
      return { observed: value.value };
    },
  });
  const tool = defineTool("fixture_tool", toolAction, {
    name: "Fixture Tool",
    description: "Returns its input for Goal causality coverage.",
  });
  const nested = defineAction({
    id: "fixture.goal.nested",
    execute(value: unknown) {
      return value;
    },
  });
  const stop = defineAction({
    id: "fixture.goal.stop",
    async execute(value: GoalStopActionInput, context: ActionContext) {
      counters.stop += 1;
      if (input.stop) return await input.stop(value, counters, context);
      return value.turn >= (input.maxTurns ?? 2)
        ? { stop: true, status: "completed" as const, reason: "fixture done" }
        : { stop: false };
    },
  });
  const evaluate = defineAction({
    id: "fixture.goal.evaluate",
    async execute(value: GoalEvaluateActionInput, context: ActionContext) {
      counters.evaluate += 1;
      if (input.evaluate) return await input.evaluate(value, context, counters);
      const messageId = value.judgeMessageId ?? value.finalMessageId;
      const message = messageId
        ? await context.collections.message.get({ id: messageId })
        : null;
      return {
        assessments: [{
          name: "fixture",
          status: "completed" as const,
          score: 0.8,
          report: Array.isArray(message?.content) ? message.content : [],
          metadata: { evaluator: "fixture" },
        }],
      };
    },
  });
  const handler = input.handler ?? ((call: LlmAdapterCallInput) => {
    const selected = activeAgent(call);
    if (selected === "target-agent") {
      counters.target += 1;
      return counters.target === 1
        ? result("Which details should I use?", {
          type: "text",
          text: "TARGET_PRIVATE_REASONING",
          role: "reasoning",
        })
        : result([
          { type: "text", text: "Payment link generated", role: "body" },
          {
            type: "image",
            bytes: new Uint8Array([1, 2, 3]),
            mediaType: "image/png",
            role: "attachment",
          },
        ]);
    }
    if (selected === "lead-agent") {
      counters.lead += 1;
      return result("Use the passenger details on file");
    }
    counters.judge += 1;
    return result("PASS");
  });
  const resourceActions = {
    fixtureStop: stop,
    fixtureEvaluate: evaluate,
    fixtureNested: nested,
    fixture_tool: toolAction,
  };
  const resources = definePlugin({
    id: "fixture.goals.resources",
    version: "1.0.0",
    actions: resourceActions,
    resources: {
      agents: {
        targetAlias: agent("target-agent", "Target", input.withTool),
        leadAlias: agent("lead-agent", "Lead"),
        judgeAlias: agent("judge-agent", "Judge"),
      },
      models: {
        goalModel: { adapter: "fixture", model: "fixture-model" },
      },
      tools: { fixture_tool: tool },
    },
    adapters: {
      llm: { fixture: adapterFrom((call) => handler(call, counters)) },
    },
  });
  const baseGoalsPlugin = createGoalsPlugin({
    goals: {
      booking: defineGoal({
        target: "targetAlias",
        lead: "leadAlias",
        ...(input.withJudge
          ? { judge: { agent: "judgeAlias", instructions: "Judge exactly." } }
          : {}),
        maxTurns: input.maxTurns ?? 2,
        stopAction: input.stopActionAlias ?? "fixtureStop",
        ...(input.withJudge || input.withEvaluate
          ? { evaluateAction: "fixtureEvaluate" }
          : {}),
      }),
    },
  });
  const delayedMessage = defineProcessor({
    id: "fixture.goals.delayed-message",
    on: baseGoalsPlugin.processors.message.on,
    async handle(event, context) {
      const message = (event.data as {
        record?: Readonly<{ metadata?: unknown }>;
      }).record;
      const metadata = message?.metadata as Record<string, unknown> | undefined;
      if (
        input.delayGoalToolFacts && metadata &&
        (workflowMetadata(metadata)?.kind === "tool_result" ||
          coreToolPlanMetadata(metadata))
      ) await input.delayGoalToolFacts;
      await baseGoalsPlugin.processors.message.handle(
        event as never,
        context as never,
      );
    },
  });
  const delayedStopRequest = defineProcessor({
    id: "fixture.goals.delayed-stop-request",
    on: baseGoalsPlugin.processors.stopRequest.on,
    async handle(event, context) {
      await baseGoalsPlugin.processors.stopRequest.handle(
        event as never,
        (input.hideStopActionFromGoalProcessor
          ? {
            ...context,
            actions: { ...context.actions, fixtureStop: undefined },
          }
          : context) as never,
      );
    },
  });
  const delayedEvaluationRequest = defineProcessor({
    id: "fixture.goals.delayed-evaluation-request",
    on: baseGoalsPlugin.processors.evaluation.on,
    async handle(event, context) {
      await baseGoalsPlugin.processors.evaluation.handle(
        event as never,
        (input.hideEvaluateActionFromGoalProcessor
          ? {
            ...context,
            actions: { ...context.actions, fixtureEvaluate: undefined },
          }
          : context) as never,
      );
    },
  });
  const configuredLifecycle = defineProcessor({
    id: "fixture.goals.configured-lifecycle",
    on: baseGoalsPlugin.processors.configuredActionLifecycle.on,
    async handle(event, context) {
      if (
        input.failConfiguredStopReceiptOnce &&
        !input.failConfiguredStopReceiptOnce.failed &&
        event.type === "fixture.goal.stop.completed"
      ) {
        input.failConfiguredStopReceiptOnce.failed = true;
        throw new Error("Fixture failed before applying the stop receipt.");
      }
      await baseGoalsPlugin.processors.configuredActionLifecycle.handle(
        event as never,
        context as never,
      );
    },
  });
  const goalsPlugin = definePlugin({
    id: "fixture.goals",
    version: "1.0.0",
    plugins: baseGoalsPlugin.plugins,
    collections: baseGoalsPlugin.collections,
    actions: baseGoalsPlugin.actions,
    processors: {
      ...baseGoalsPlugin.processors,
      message: delayedMessage,
      stopRequest: delayedStopRequest,
      evaluation: delayedEvaluationRequest,
      configuredActionLifecycle: configuredLifecycle,
    },
    resources: baseGoalsPlugin.resources,
    adapters: baseGoalsPlugin.adapters,
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: input.schema ?? SCHEMA,
    plugins: [goalsPlugin, resources],
    engine: {
      retryBaseMs: input.retryBaseMs ?? 0,
      random: input.retryRandom ?? (() => 0),
    },
  });
  return { application, counters, db };
}

async function goal(
  application: Awaited<ReturnType<typeof createCopilotzApplication>>,
  id: string,
  schema = SCHEMA,
): Promise<GoalRecord> {
  const scope = await application.databaseScope(schema);
  const value = await scope.collections.withScope({ namespace: NAMESPACE })
    .goal.get({ id });
  assertExists(value);
  return asGoalRecord(value);
}

async function waitForGoalStatus(
  application: Awaited<ReturnType<typeof createCopilotzApplication>>,
  id: string,
  status: GoalRecord["status"],
  schema = SCHEMA,
): Promise<GoalRecord> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const scope = await application.databaseScope(schema);
    const value = await scope.collections.withScope({ namespace: NAMESPACE })
      .goal.get({ id });
    if (value) {
      const current = asGoalRecord(value);
      if (current.status === status) return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Goal '${id}' did not reach '${status}'.`);
}

async function waitForDelivery(
  application: Awaited<ReturnType<typeof createCopilotzApplication>>,
  consumerId: string,
  status: string,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const delivery = (await application.deliveries.list({
      namespace: NAMESPACE,
      limit: 500,
    })).find((entry) =>
      entry.consumerId === consumerId && entry.status === status
    );
    if (delivery) return delivery;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Consumer '${consumerId}' did not reach delivery status '${status}'.`,
  );
}

async function recoverConsumer(
  application: Awaited<ReturnType<typeof createCopilotzApplication>>,
  consumerId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const recovery = await application.recover({
      namespace: NAMESPACE,
      consumerIds: [consumerId],
    });
    if (recovery.handles.length > 0) {
      await Promise.all(recovery.handles.map((handle) => handle.done));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Consumer '${consumerId}' had no recoverable delivery.`);
}

async function message(
  application: Awaited<ReturnType<typeof createCopilotzApplication>>,
  id: string,
  schema = SCHEMA,
) {
  const scope = await application.databaseScope(schema);
  const value = await scope.collections.withScope({ namespace: NAMESPACE })
    .message.get({ id });
  assertExists(value);
  return value;
}

async function settled(
  application: Awaited<ReturnType<typeof createCopilotzApplication>>,
  handle: Readonly<{ eventId: string; done: Promise<void> }>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      handle.done,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(async () => {
          const deliveries = await application.deliveries.list({
            namespace: NAMESPACE,
            limit: 500,
          });
          const settlement = await application.events.settlement(
            NAMESPACE,
            handle.eventId,
          );
          const advances = await projectActionEvents(
            application,
            NAMESPACE,
            "copilotz.goals.advance",
          );
          const scoped = (await application.databaseScope(SCHEMA)).collections
            .withScope({ namespace: NAMESPACE });
          const currentGoal = await scoped.goal.get({ id: "goal-loop" });
          reject(
            new Error(
              `Goal settlement timed out: ${
                JSON.stringify({
                  settlement,
                  currentGoal,
                  advances: advances.filter((entry) =>
                    entry.status === "failed" || entry.status === "cancelled"
                  ).slice(-3),
                  deliveries: deliveries.slice(-10),
                })
              }`,
            ),
          );
        }, 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

Deno.test("Goals is an ordinary typed plugin with strict data-only ingress", () => {
  const resource = defineGoal({
    target: "targetAlias",
    lead: "leadAlias",
    maxTurns: 2,
  });
  const plugin = createGoalsPlugin({ goals: { booking: resource } });
  assertEquals(Object.keys(plugin.collections), ["goal"]);
  assertEquals(Object.keys(plugin.resources.goals), ["booking"]);
  const typedBooking: GoalResource = plugin.resources.goals.booking;
  assertEquals(typedBooking.maxTurns, 2);
  // @ts-expect-error the factory preserves exact resource aliases.
  void plugin.resources.goals.missing;
  assertEquals("features" in plugin, false);
  const envelope = startGoal({
    goal: "booking",
    id: "goal-input",
    content: {
      type: "image",
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
      origin: {
        type: "request",
        id: "goal-input",
      },
    },
    sender: { externalId: "client" },
    namespace: NAMESPACE,
    databaseSchema: SCHEMA,
    causationId: "cause",
    correlationId: "correlation",
    deduplicationId: "dedup",
  });
  assertExists(envelope.payload);
  assertEquals(envelope.payload.content, {
    type: "image",
    mediaType: "image/png",
    origin: {
      type: "request",
      id: "goal-input",
    },
    dataBase64: "AQID",
  });
  assert(
    Object.isFrozen((envelope.payload.content as { origin: object }).origin),
  );
  assertEquals("correlationId" in envelope.payload, false);
  assertThrows(
    () =>
      startGoal({
        goal: "booking",
        content: {
          assetId: "asset",
          kind: "wrong",
          role: "body",
          mediaType: "text/plain",
        } as never,
        sender: { externalId: "client" },
      }),
    TypeError,
  );
  assertThrows(
    () =>
      startGoal({
        goal: "booking",
        content: "hello",
        sender: { externalId: "client", email: 42 as never },
      }),
    TypeError,
  );
  assertThrows(
    () =>
      startGoal({
        goal: "booking",
        content: "hello",
        sender: { externalId: "client" },
        thread: "   ",
      }),
    TypeError,
  );
  assertThrows(
    () =>
      startGoal({
        goal: "booking",
        content: "hello",
        sender: { externalId: "client" },
        metadata: 1 as never,
      }),
    TypeError,
  );
});

Deno.test("inherited Object properties are never callable Action aliases", async () => {
  const run = await fixture({ stopActionAlias: "toString", maxTurns: 1 });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-inherited-action-alias",
      content: "Book a ticket",
      sender: { externalId: "client" },
    }));
    await settled(run.application, sent);
    const scope = await run.application.databaseScope(SCHEMA);
    assertEquals(
      await scope.collections.withScope({ namespace: NAMESPACE }).goal.get({
        id: "goal-inherited-action-alias",
      }),
      null,
    );
    assertEquals(run.counters.target, 0);
    assertEquals(run.counters.stop, 0);
    const lifecycle = await projectActionEvents(
      run.application,
      NAMESPACE,
      "copilotz.goals.start",
    );
    assertEquals(lifecycle.map((entry) => entry.status), [
      "invoked",
      "failed",
    ]);
  } finally {
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("durable Goal advances bounded turns exactly once and reuses final refs", async () => {
  const run = await fixture();
  try {
    const request = startGoal({
      goal: "booking",
      id: "goal-loop",
      content: "Book a ticket",
      sender: { externalId: "client", name: "Client" },
      metadata: { trace: "preserved" },
      deduplicationId: "goal-loop:start",
    });
    const sent = await run.application.send(request);
    await settled(run.application, sent);
    const record = await goal(run.application, "goal-loop");
    const projected = goalResult(record);
    assertEquals(projected.status, "completed");
    assertEquals(projected.turns, 2);
    assertEquals(projected.metrics.targetRuns, 2);
    assertEquals(projected.metrics.leadRuns, 1);
    assertEquals(run.counters, {
      target: 2,
      lead: 1,
      judge: 0,
      stop: 2,
      evaluate: 0,
      tool: 0,
    });
    assertEquals(record.targetAgentId, "target-agent");
    assertEquals(record.leadAgentId, "lead-agent");
    const targetOutput = await message(
      run.application,
      record.transcript[0].outputMessageId!,
    );
    const initialInput = await message(
      run.application,
      record.transcript[0].inputMessageId,
    );
    assertEquals(record.inputContent, initialInput.content);
    const leadInput = await message(
      run.application,
      record.transcript[1].inputMessageId,
    );
    assertEquals(leadInput.content, targetOutput.content);
    assertEquals(
      (leadInput.content as readonly { role: string }[]).some((ref) =>
        ref.role === "reasoning"
      ),
      false,
    );
    const final = await message(run.application, record.finalMessageId!);
    assertEquals(
      (final.content as readonly { kind: string }[]).map((ref) => ref.kind),
      ["text", "image"],
    );
  } finally {
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("consecutive Tool plans advance only on the final post-Tool output", async () => {
  const releaseGoalToolFacts = Promise.withResolvers<void>();
  const run = await fixture({
    withTool: true,
    maxTurns: 1,
    delayGoalToolFacts: releaseGoalToolFacts.promise,
    handler(call, counters) {
      const selected = activeAgent(call);
      if (selected !== "target-agent") {
        throw new Error(`Unexpected Tool-chain Agent '${selected}'.`);
      }
      counters.target += 1;
      if (counters.target <= 2) {
        return {
          content: [],
          toolCalls: [{
            id: `goal-tool-call-${counters.target}`,
            action: "fixture_tool",
            input: { value: `step-${counters.target}` },
          }],
          attempts: [{ status: "completed" as const }],
          finishReason: "tool_calls",
        };
      }
      return result("Final answer after consecutive tools");
    },
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-tool-chain",
      content: "Use the fixture tool twice",
      sender: { externalId: "client" },
    }));
    // Core has already persisted both plans/results, but their Goals
    // deliveries remain blocked. The final assistant delivery must resolve its
    // complete Tool ancestry back to the original awaited trigger.
    await waitForGoalStatus(run.application, "goal-tool-chain", "completed");
    releaseGoalToolFacts.resolve();
    await settled(run.application, sent);
    const record = await goal(run.application, "goal-tool-chain");
    assertEquals(record.status, "completed");
    assertEquals(run.counters.target, 3);
    assertEquals(run.counters.tool, 2);
    assertEquals(run.counters.stop, 1);
    assertEquals(record.metrics.messages, 1);
    assertEquals(record.transcript.length, 1);
    const messages = await projectMessages(
      run.application,
      NAMESPACE,
      record.threadId,
    );
    assertEquals(messages.map((entry) => entry.sender.participantType), [
      "human",
      "agent",
      "tool",
      "agent",
      "tool",
      "agent",
    ]);
    assertEquals(record.transcript[0].outputMessageId, messages[5].id);
    assertEquals(record.finalMessageId, messages[5].id);
  } finally {
    releaseGoalToolFacts.resolve();
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("an LLM failure resolves through delayed consecutive-Tool ancestry and evaluates", async () => {
  const releaseGoalToolFacts = Promise.withResolvers<void>();
  const run = await fixture({
    withTool: true,
    withEvaluate: true,
    maxTurns: 1,
    delayGoalToolFacts: releaseGoalToolFacts.promise,
    handler(call, counters) {
      const selected = activeAgent(call);
      if (selected !== "target-agent") {
        throw new Error(`Unexpected Tool-chain Agent '${selected}'.`);
      }
      counters.target += 1;
      if (counters.target <= 2) {
        return {
          content: [],
          toolCalls: [{
            id: `goal-failing-tool-call-${counters.target}`,
            action: "fixture_tool",
            input: { value: `step-${counters.target}` },
          }],
          attempts: [{ status: "completed" as const }],
          finishReason: "tool_calls",
        };
      }
      throw new Error("provider failed after Tool continuations");
    },
    evaluate() {
      return undefined;
    },
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-tool-chain-failure",
      content: "Use the fixture tool twice, then fail",
      sender: { externalId: "client" },
    }));
    const terminal = await waitForGoalStatus(
      run.application,
      "goal-tool-chain-failure",
      "error",
    );
    releaseGoalToolFacts.resolve();
    await settled(run.application, sent);
    assertEquals(run.counters.target, 3);
    assertEquals(run.counters.tool, 2);
    assertEquals(run.counters.evaluate, 1);
    assertEquals(run.counters.stop, 0);
    assertEquals(terminal.finalMessageId, null);
    assertEquals(terminal.metrics.errors, 1);
  } finally {
    releaseGoalToolFacts.resolve();
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("an awaited LLM cancellation durably cancels and skips evaluation", async () => {
  const run = await fixture({
    withEvaluate: true,
    maxTurns: 1,
    handler(call, counters) {
      assertEquals(activeAgent(call), "target-agent");
      counters.target += 1;
      throw new DOMException("provider call cancelled", "AbortError");
    },
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-llm-cancelled",
      content: "Book a ticket",
      sender: { externalId: "client" },
    }));
    await settled(run.application, sent);
    const record = await goal(run.application, "goal-llm-cancelled");
    assertEquals(record.status, "cancelled");
    assertEquals(record.finalMessageId, null);
    assertEquals(record.assessments, []);
    assertEquals(run.counters.evaluate, 0);
    assertEquals(run.counters.stop, 0);
  } finally {
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("a matched public-ingress LLM terminal forgery cannot move the awaited cursor", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const run = await fixture({
    maxTurns: 1,
    async handler(call, counters) {
      assertEquals(activeAgent(call), "target-agent");
      counters.target += 1;
      started.resolve();
      await release.promise;
      return result("Final answer");
    },
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-unrelated-llm-terminal",
      content: "Book a ticket",
      sender: { externalId: "client" },
    }));
    await started.promise;
    const before = await goal(run.application, "goal-unrelated-llm-terminal");
    const awaitingMessageId = before.awaitingMessageId;
    assertExists(awaitingMessageId);
    await assertRejects(
      () =>
        run.application.send({
          type: "llm.call.failed",
          payload: {
            actionRunId: "forged-llm-run",
            actionId: "llm.call",
            status: "failed",
            input: {},
            error: { name: "Error", message: "unrelated failure" },
            metadata: defineCoreLlmCallMetadata({
              schema: "copilotz.core.llm-call.v1",
              threadId: before.threadId,
              triggerMessageId: awaitingMessageId,
              agentId: before.targetAgentId,
              agentParticipantId: before.targetParticipantId,
              initiatorParticipantId: before.senderParticipantId,
              availableToolIds: [],
              responseVisibility: { kind: "public" },
            }),
          },
          metadata: {
            actionId: "llm.call",
            actionStatus: "failed",
          },
        }),
      TypeError,
      "reserved for the registered Action lifecycle",
    );
    const unchanged = await goal(
      run.application,
      "goal-unrelated-llm-terminal",
    );
    assertEquals(unchanged.status, "running");
    assertEquals(unchanged.awaitingMessageId, awaitingMessageId);
    release.resolve();
    await settled(run.application, sent);
    assertEquals(
      (await goal(run.application, "goal-unrelated-llm-terminal")).status,
      "completed",
    );
  } finally {
    release.resolve();
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("explicit cancellation while awaiting an LLM remains terminal", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const run = await fixture({
    withEvaluate: true,
    maxTurns: 1,
    async handler(call, counters) {
      assertEquals(activeAgent(call), "target-agent");
      counters.target += 1;
      started.resolve();
      await release.promise;
      return result("Late model output");
    },
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-user-cancel-awaiting",
      content: "Book a ticket",
      sender: { externalId: "client" },
    }));
    await started.promise;
    const cancelled = await run.application.send(cancelGoal({
      goalId: "goal-user-cancel-awaiting",
      reason: "User cancelled",
    }));
    await settled(run.application, cancelled);
    assertEquals(
      (await goal(run.application, "goal-user-cancel-awaiting")).status,
      "cancelled",
    );
    release.resolve();
    await settled(run.application, sent);
    const record = await goal(run.application, "goal-user-cancel-awaiting");
    assertEquals(record.status, "cancelled");
    assertEquals(record.finalMessageId, null);
    assertEquals(run.counters.stop, 0);
    assertEquals(run.counters.evaluate, 0);
  } finally {
    release.resolve();
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("explicit cancellation wins while evaluation is in flight", async () => {
  const evaluationStarted = Promise.withResolvers<void>();
  const releaseEvaluation = Promise.withResolvers<void>();
  const run = await fixture({
    withEvaluate: true,
    maxTurns: 1,
    async evaluate() {
      evaluationStarted.resolve();
      await releaseEvaluation.promise;
      return { assessments: [{ status: "completed" as const }] };
    },
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-user-cancel-evaluating",
      content: "Book a ticket",
      sender: { externalId: "client" },
    }));
    await evaluationStarted.promise;
    const cancelled = await run.application.send(cancelGoal({
      goalId: "goal-user-cancel-evaluating",
      reason: "User cancelled during evaluation",
    }));
    await settled(run.application, cancelled);
    assertEquals(
      (await goal(run.application, "goal-user-cancel-evaluating")).status,
      "cancelled",
    );
    releaseEvaluation.resolve();
    await settled(run.application, sent);
    const record = await goal(
      run.application,
      "goal-user-cancel-evaluating",
    );
    assertEquals(record.status, "cancelled");
    assertEquals(record.assessments, []);
    assertEquals(record.evaluationRequestId, null);
    assertEquals(run.counters.evaluate, 1);
  } finally {
    releaseEvaluation.resolve();
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("judge receives only Goal-owned canonical transcript assets and evaluate runs once", async () => {
  const judgeKinds: string[] = [];
  const run = await fixture({
    withJudge: true,
    maxTurns: 2,
    handler(call, counters) {
      const selected = activeAgent(call);
      if (selected === "target-agent") {
        counters.target += 1;
        return result([
          { type: "text", text: "Final answer", role: "body" },
          {
            type: "image",
            bytes: new Uint8Array([9, 8, 7]),
            mediaType: "image/png",
            role: "attachment",
          },
        ], { type: "text", text: "SECRET", role: "reasoning" });
      }
      if (selected === "judge-agent") {
        counters.judge += 1;
        judgeKinds.push(
          ...call.request.messages.flatMap((entry) =>
            entry.content.map((part) => part.type)
          ),
        );
        return result("PASS");
      }
      counters.lead += 1;
      return result("unused");
    },
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-judge",
      content: "Assess this",
      sender: { externalId: "client" },
    }));
    await settled(run.application, sent);
    const record = await goal(run.application, "goal-judge");
    const projected = goalResult(record);
    assertEquals(projected.status, "completed");
    assertEquals(record.metrics.judgeRuns, 1);
    assertEquals(run.counters.evaluate, 1);
    assert(judgeKinds.includes("image"));
    assertEquals(projected.score, 0.8);
    assertEquals(projected.assessments.length, 1);
    const judgeMessage = await message(run.application, record.judgeMessageId!);
    assertEquals(projected.report, judgeMessage.content);
    assertEquals(
      projected.report.length,
      (judgeMessage.content as readonly unknown[]).length,
    );
    assert(Object.isFrozen(projected.assessments[0].metadata));
    assert(Object.isFrozen(projected.report[0]));
    const events = await run.application.events.list({
      namespace: NAMESPACE,
      limit: 500,
    });
    const leadCoordinate = record.transcript.find((entry) =>
      entry.phase === "lead"
    );
    const judgeCoordinate = record.transcript.find((entry) =>
      entry.phase === "judge"
    );
    assertExists(leadCoordinate?.outputMessageId);
    assertExists(judgeCoordinate?.outputMessageId);
    for (
      const [messageId, participants] of [
        [
          leadCoordinate.inputMessageId,
          [record.leadInputParticipantId, record.leadParticipantId],
        ],
        [
          leadCoordinate.outputMessageId,
          [record.leadInputParticipantId, record.leadParticipantId],
        ],
        [
          judgeCoordinate.inputMessageId,
          [record.judgeInputParticipantId!, record.judgeParticipantId!],
        ],
        [
          judgeCoordinate.outputMessageId,
          [record.judgeInputParticipantId!, record.judgeParticipantId!],
        ],
      ] as const
    ) {
      const created = events.find((event) =>
        event.type === "message.created" && event.subject?.id === messageId
      );
      assertExists(created);
      assertEquals(created.visibility.kind, "participants");
      assertEquals(
        created.visibility.kind === "participants"
          ? [...created.visibility.participantIds].sort()
          : [],
        [...participants].sort(),
      );
    }
  } finally {
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("completed evaluator receipt is not reinvoked when report Assets are invalid", async () => {
  const run = await fixture({
    withEvaluate: true,
    maxTurns: 1,
    evaluate() {
      return {
        assessments: [{
          status: "completed" as const,
          report: [{
            assetId: "missing-evaluation-report",
            kind: "text" as const,
            role: "body",
            mediaType: "text/plain",
          }],
        }],
      };
    },
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-missing-report",
      content: "Book a ticket",
      sender: { externalId: "client" },
    }));
    await settled(run.application, sent);
    const record = await goal(run.application, "goal-missing-report");
    assertEquals(record.status, "error");
    assertEquals(record.resultContent, []);
    assertEquals(run.counters.evaluate, 1);
    assertEquals(record.evaluationRequestId, null);
  } finally {
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("evaluator ContentRefs are exact-normalized without reinvocation", async () => {
  const run = await fixture({
    withEvaluate: true,
    maxTurns: 1,
    async evaluate(value, context) {
      const final = await context.collections.message.get({
        id: value.finalMessageId!,
      });
      assertExists(final);
      const ref = (final.content as readonly Record<string, unknown>[])[0];
      return {
        assessments: [{
          status: "completed" as const,
          report: [{ ...ref, kind: "garbage", injected: true }],
        }],
      };
    },
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-invalid-ref",
      content: "Book a ticket",
      sender: { externalId: "client" },
    }));
    await settled(run.application, sent);
    const record = await goal(run.application, "goal-invalid-ref");
    assertEquals(record.status, "error");
    assertEquals(record.resultContent, []);
    assertEquals(run.counters.evaluate, 1);
  } finally {
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("evaluator wrapper and assessments reject unknown or ill-typed fields", async () => {
  const run = await fixture({
    withEvaluate: true,
    maxTurns: 1,
    evaluate() {
      return {
        assessments: [{
          status: "completed",
          name: 42,
          typo: true,
        }],
        wrapperTypo: true,
      };
    },
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-invalid-evaluation-shape",
      content: "Book a ticket",
      sender: { externalId: "client" },
    }));
    await settled(run.application, sent);
    const record = await goal(
      run.application,
      "goal-invalid-evaluation-shape",
    );
    assertEquals(record.status, "error");
    assertEquals(run.counters.evaluate, 1);
  } finally {
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("invalid stop receipt is a non-overridable operational error", async () => {
  const run = await fixture({
    withJudge: true,
    maxTurns: 1,
    stop: () => ({ stop: true, operationalError: false }),
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-invalid-stop",
      content: "Book a ticket",
      sender: { externalId: "client" },
    }));
    await settled(run.application, sent);
    const record = await goal(run.application, "goal-invalid-stop");
    assertEquals(record.status, "error");
    assertEquals(run.counters.stop, 1);
    assertEquals(run.counters.judge, 0);
    assertEquals(run.counters.evaluate, 0);
    assertEquals(record.metrics.errors, 1);
  } finally {
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("forged and nested lifecycle facts cannot resolve a configured request", async () => {
  const release = Promise.withResolvers<void>();
  const nestedFinished = Promise.withResolvers<void>();
  const run = await fixture({
    maxTurns: 1,
    async stop(value, _counters, context) {
      await context.actions.fixtureNested(value, {
        operationKey: "nested-stop",
        metadata: context.action.metadata,
      });
      nestedFinished.resolve();
      await release.promise;
      return { stop: true, status: "completed" as const };
    },
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-lifecycle-authority",
      content: "Book a ticket",
      sender: { externalId: "client" },
    }));
    await nestedFinished.promise;
    const pending = await goal(run.application, "goal-lifecycle-authority");
    assertEquals(pending.stopStatus, "requested");
    assertExists(pending.stopRequestId);
    const configuredInput: GoalStopActionInput = {
      goalId: pending.id,
      turn: pending.turn,
      finalMessageId: pending.responseMessageId!,
      resource: pending.resource,
    };
    await assertRejects(
      () =>
        run.application.send({
          type: "fixture.goal.stop.completed",
          payload: {
            actionRunId: "forged-stop-run",
            actionId: "fixture.goal.stop",
            status: "completed",
            metadata: {
              copilotzGoalAction: {
                schema: "copilotz.goal.action.v1",
                kind: "stop",
                goalId: pending.id,
                requestId: pending.stopRequestId,
                actionAlias: "fixtureStop",
              },
            },
            input: configuredInput,
            output: { stop: true, status: "failed" },
          },
          metadata: {
            actionId: "fixture.goal.stop",
            actionStatus: "completed",
          },
          correlationId: pending.correlationId,
        }),
      TypeError,
      "reserved for the registered Action lifecycle",
    );
    const unknownAction = await run.application.send({
      type: "evil.completed",
      payload: {
        actionRunId: "evil-run",
        actionId: "evil",
        status: "completed",
        metadata: {
          copilotzGoalAction: {
            schema: "copilotz.goal.action.v1",
            kind: "stop",
            goalId: pending.id,
            requestId: pending.stopRequestId,
            actionAlias: "fixtureStop",
          },
        },
        input: configuredInput,
        output: { stop: true, status: "failed" },
      },
      metadata: { actionId: "evil", actionStatus: "completed" },
      correlationId: pending.correlationId,
    });
    await settled(run.application, unknownAction);
    assertEquals(
      (await goal(run.application, pending.id)).stopStatus,
      "requested",
    );
    release.resolve();
    await settled(run.application, sent);
    assertEquals((await goal(run.application, pending.id)).status, "completed");
    assertEquals(run.counters.stop, 1);
  } finally {
    release.resolve();
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("cancelled configured-Action receipt durably requests one fresh attempt", async () => {
  const run = await fixture({
    withEvaluate: true,
    maxTurns: 1,
    evaluate(_input, _context, counters) {
      if (counters.evaluate === 1) {
        throw new DOMException("fixture shutdown", "AbortError");
      }
      return undefined;
    },
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-evaluation-retry",
      content: "Book a ticket",
      sender: { externalId: "client" },
    }));
    await settled(run.application, sent);
    const record = await goal(run.application, "goal-evaluation-retry");
    assertEquals(record.status, "completed");
    assertEquals(run.counters.evaluate, 2);
    const lifecycle = await projectActionEvents(
      run.application,
      NAMESPACE,
      "fixture.goal.evaluate",
    );
    assertEquals(lifecycle.map((entry) => entry.status), [
      "invoked",
      "cancelled",
      "invoked",
      "completed",
    ]);
  } finally {
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("an always-cancelled stop Action is bounded to two durable attempts", async () => {
  const run = await fixture({
    maxTurns: 1,
    stop() {
      throw new DOMException("fixture stop aborted", "AbortError");
    },
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-stop-cancel-bound",
      content: "Book a ticket",
      sender: { externalId: "client" },
    }));
    await settled(run.application, sent);
    const record = await goal(run.application, "goal-stop-cancel-bound");
    assertEquals(record.status, "error");
    assertEquals(run.counters.stop, 2);
    assertEquals(record.metrics.errors, 1);
    assertEquals(record.stopAttempt, 0);
    assertEquals(record.stopRequestId, null);
    const lifecycle = await projectActionEvents(
      run.application,
      NAMESPACE,
      "fixture.goal.stop",
    );
    assertEquals(lifecycle.map((entry) => entry.status), [
      "invoked",
      "cancelled",
      "invoked",
      "cancelled",
    ]);
  } finally {
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("an always-cancelled evaluator is bounded to two durable attempts", async () => {
  const run = await fixture({
    withEvaluate: true,
    maxTurns: 1,
    evaluate() {
      throw new DOMException("fixture evaluation aborted", "AbortError");
    },
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-evaluation-cancel-bound",
      content: "Book a ticket",
      sender: { externalId: "client" },
    }));
    await settled(run.application, sent);
    const record = await goal(
      run.application,
      "goal-evaluation-cancel-bound",
    );
    assertEquals(record.status, "error");
    assertEquals(run.counters.evaluate, 2);
    assertEquals(record.metrics.errors, 1);
    assertEquals(record.evaluationAttempt, 0);
    assertEquals(record.evaluationRequestId, null);
    const lifecycle = await projectActionEvents(
      run.application,
      NAMESPACE,
      "fixture.goal.evaluate",
    );
    assertEquals(lifecycle.map((entry) => entry.status), [
      "invoked",
      "cancelled",
      "invoked",
      "cancelled",
    ]);
  } finally {
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("a durable requested stop recovers after an in-flight engine restart", async () => {
  const schema = "goal_inflight_restart";
  const failReceipt = { failed: false };
  const first = await fixture({
    schema,
    maxTurns: 1,
    failConfiguredStopReceiptOnce: failReceipt,
    retryBaseMs: 100,
    retryRandom: () => 1,
  });
  let restarted:
    | Awaited<ReturnType<typeof fixture>>
    | undefined;
  try {
    const input = startGoal({
      goal: "booking",
      id: "goal-inflight-restart",
      content: "Book a ticket",
      sender: { externalId: "client" },
      databaseSchema: schema,
      correlationId: "goal-inflight-restart",
      deduplicationId: "goal-inflight-restart:start",
    });
    await first.application.events.append({
      type: input.type,
      namespace: NAMESPACE,
      payload: input.payload,
      visibility: { kind: "public" },
      correlationId: "goal-inflight-restart",
      deduplicationId: "goal-inflight-restart:start",
    });
    await waitForDelivery(
      first.application,
      "processor:fixture.goals.configured-lifecycle",
      "retry_wait",
    );
    const requested = await goal(
      first.application,
      "goal-inflight-restart",
      schema,
    );
    assertEquals(requested.stopStatus, "requested");
    assertEquals(requested.stopAttempt, 1);
    assertEquals(first.counters.stop, 1);
    assertEquals(failReceipt.failed, true);

    // No application send handle owns this low-level durable ingress, so a
    // graceful runtime stop cannot cancel its retry-wait receipt delivery.
    await first.application.shutdown();
    restarted = await fixture({
      db: first.db,
      schema,
      counters: first.counters,
      maxTurns: 1,
    });
    await recoverConsumer(
      restarted.application,
      "processor:fixture.goals.configured-lifecycle",
    );
    const terminal = await waitForGoalStatus(
      restarted.application,
      "goal-inflight-restart",
      "completed",
      schema,
    );
    assertEquals(terminal.status, "completed");
    assertEquals(terminal.stopRequestId, null);
    assertEquals(first.counters.stop, 1);
    const lifecycle = await projectActionEvents(
      restarted.application,
      NAMESPACE,
      "fixture.goal.stop",
    );
    assertEquals(lifecycle.map((entry) => entry.status), [
      "invoked",
      "completed",
    ]);
  } finally {
    if (restarted) await restarted.application.shutdown();
    await first.application.shutdown();
    await first.db.close();
  }
});

Deno.test("a persisted stop request terminalizes when the active composition lost its alias", async () => {
  // The Processor receives the caller map a restarted application would have
  // after removing the snapshotted alias; start-time validation still saw it.
  const run = await fixture({
    maxTurns: 1,
    hideStopActionFromGoalProcessor: true,
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-missing-action-restart",
      content: "Book a ticket",
      sender: { externalId: "client" },
    }));
    await settled(run.application, sent);
    const terminal = await goal(
      run.application,
      "goal-missing-action-restart",
    );
    assertEquals(terminal.status, "error");
    assertEquals(terminal.stopRequestId, null);
    assertEquals(terminal.metrics.errors, 1);
    assertEquals(run.counters.stop, 0);
  } finally {
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("a persisted evaluation request terminalizes when the active composition lost its alias", async () => {
  const run = await fixture({
    withEvaluate: true,
    maxTurns: 1,
    hideEvaluateActionFromGoalProcessor: true,
  });
  try {
    const sent = await run.application.send(startGoal({
      goal: "booking",
      id: "goal-missing-evaluation-restart",
      content: "Book a ticket",
      sender: { externalId: "client" },
    }));
    await settled(run.application, sent);
    const terminal = await goal(
      run.application,
      "goal-missing-evaluation-restart",
    );
    assertEquals(terminal.status, "error");
    assertEquals(terminal.evaluationRequestId, null);
    assertEquals(terminal.metrics.errors, 1);
    assertEquals(run.counters.stop, 1);
    assertEquals(run.counters.evaluate, 0);
  } finally {
    await run.application.shutdown();
    await run.db.close();
  }
});

Deno.test("terminal Goal survives restart and duplicate start/cancel are idempotent", async () => {
  const first = await fixture({ schema: "goal_restart" });
  const request = startGoal({
    goal: "booking",
    id: "goal-restart",
    content: "Book a ticket",
    sender: { externalId: "client" },
    databaseSchema: "goal_restart",
    correlationId: "goal-restart",
    deduplicationId: "goal-restart:start",
  });
  try {
    const sent = await first.application.send(request);
    await settled(first.application, sent);
    assertEquals(
      (await goal(
        first.application,
        "goal-restart",
        "goal_restart",
      )).status,
      "completed",
    );
    await first.application.shutdown();

    const restarted = await fixture({
      db: first.db,
      schema: "goal_restart",
      counters: first.counters,
    });
    try {
      const replay = await restarted.application.send(request);
      await settled(restarted.application, replay);
      assertEquals(first.counters.stop, 2);
      const lateCancel = await restarted.application.send(cancelGoal({
        goalId: "goal-restart",
        databaseSchema: "goal_restart",
        deduplicationId: "goal-restart:late-cancel",
      }));
      await settled(restarted.application, lateCancel);
      const record = await goal(
        restarted.application,
        "goal-restart",
        "goal_restart",
      );
      assertEquals(record.status, "completed");
      assertEquals(record.transitionClaimId, null);
      assertEquals(record.evaluationRequestId, null);
    } finally {
      await restarted.application.shutdown();
    }
  } finally {
    await first.application.shutdown();
    await first.db.close();
  }
});
