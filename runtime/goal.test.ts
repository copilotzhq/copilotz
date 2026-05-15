import { assert, assertEquals } from "@std/assert";

import { createCopilotz } from "@/index.ts";
import type {
  Event,
  EventProcessor,
  MessagePayload,
  NewEvent,
  ProcessorDeps,
} from "@/types/index.ts";

const testedAgent = {
  id: "tested",
  name: "tested",
  role: "assistant",
  instructions: "Sell tickets.",
  llmOptions: { provider: "openai", model: "gpt-4o-mini" },
} as const;

const testerAgent = {
  id: "tester",
  name: "tester",
  role: "simulated customer",
  instructions: "Act like a customer.",
  llmOptions: { provider: "openai", model: "gpt-4o-mini" },
} as const;

const judgeAgent = {
  id: "judge",
  name: "judge",
  role: "goal judge",
  instructions: "Judge goal transcripts.",
  llmOptions: { provider: "openai", model: "gpt-4o-mini" },
} as const;

function text(content: MessagePayload["content"]): string {
  return typeof content === "string" ? content : "";
}

function scriptedProcessor(): EventProcessor<unknown, ProcessorDeps> & {
  eventType: string;
} {
  return {
    eventType: "NEW_MESSAGE",
    shouldProcess: () => true,
    process: async (event: Event): Promise<{ producedEvents: NewEvent[] }> => {
      const payload = event.payload as MessagePayload;
      const threadId = String(event.threadId);

      if (payload.sender?.type === "agent" && !payload.target) {
        return { producedEvents: [] };
      }

      const target = payload.target;
      let answer = "";
      if (target === "tested") {
        answer = text(payload.content).includes("details")
          ? "Payment link generated"
          : "Which passenger details should I use?";
      } else if (target === "tester") {
        answer = "Use my details";
      } else if (target === "judge") {
        answer = "PASS score=0.8";
      }

      if (!answer) return { producedEvents: [] };

      return {
        producedEvents: [{
          threadId,
          type: "NEW_MESSAGE",
          payload: {
            content: answer,
            sender: { id: target, name: target, type: "agent" },
          },
          traceId: typeof event.traceId === "string"
            ? event.traceId
            : undefined,
          parentEventId: typeof event.id === "string" ? event.id : undefined,
          metadata: event.metadata && typeof event.metadata === "object"
            ? event.metadata as Record<string, unknown>
            : undefined,
        }],
      };
    },
  };
}

function toolResultIsolationProcessor():
  & EventProcessor<unknown, ProcessorDeps>
  & {
    eventType: string;
  } {
  return {
    eventType: "NEW_MESSAGE",
    shouldProcess: () => true,
    process: async (event: Event): Promise<{ producedEvents: NewEvent[] }> => {
      const payload = event.payload as MessagePayload;
      const threadId = String(event.threadId);
      const target = payload.target;

      if (target === "tested") {
        return {
          producedEvents: [
            {
              threadId,
              type: "NEW_MESSAGE",
              payload: {
                content: "SECRET_TOOL_RESULT",
                sender: { id: "tested", name: "tested", type: "tool" },
              },
            },
            {
              threadId,
              type: "NEW_MESSAGE",
              payload: {
                content: "Which passenger details should I use?",
                sender: { id: "tested", name: "tested", type: "agent" },
              },
            },
          ],
        };
      }

      if (target === "tester") {
        const leadInput = text(payload.content);
        return {
          producedEvents: [{
            threadId,
            type: "NEW_MESSAGE",
            payload: {
              content: leadInput.includes("SECRET_TOOL_RESULT")
                ? "LEAKED_TOOL_RESULT"
                : "TOOL_RESULT_NOT_VISIBLE",
              sender: { id: "tester", name: "tester", type: "agent" },
            },
          }],
        };
      }

      return { producedEvents: [] };
    },
  };
}

Deno.test("copilotz.goal runs a target thread and private lead thread until stop", async () => {
  const tempDir = await Deno.makeTempDir();
  const copilotz = await createCopilotz({
    agents: [testedAgent, testerAgent],
    processors: [scriptedProcessor()],
    dbConfig: { url: `file://${tempDir}/goal-stop.db` },
  });

  try {
    const handle = await copilotz.goal({
      content: "I want a ticket",
      sender: {
        id: "client-01",
        type: "user",
        name: "Client One",
        usingAgent: "tester",
      },
      target: "tested",
      thread: {
        externalId: "goal-main-thread",
        participants: ["tested"],
      },
      maxTurns: 4,
      stop: ({ lastMessage }) =>
        lastMessage?.content.includes("Payment")
          ? { stop: true, status: "completed", reason: "payment generated" }
          : false,
    });

    const streamed = [];
    for await (const event of handle.events) {
      streamed.push(event);
    }

    const result = await handle.done;

    assertEquals(result.status, "completed");
    assertEquals(result.reason, "payment generated");
    assertEquals(result.metrics.targetRuns, 2);
    assertEquals(result.metrics.leadRuns, 1);
    assertEquals(
      result.transcript.map((message) => [
        message.phase,
        message.senderType,
        message.content,
      ]),
      [
        ["target", "user", "I want a ticket"],
        ["target", "agent", "Which passenger details should I use?"],
        ["lead", "user", "Which passenger details should I use?"],
        ["lead", "agent", "Use my details"],
        ["target", "user", "Use my details"],
        ["target", "agent", "Payment link generated"],
      ],
    );
    assert(streamed.some((event) => event.type === "GOAL_STOPPED"));
    assert(streamed.some((event) => event.type === "GOAL_RESULT"));
    assert(
      streamed.some((event) =>
        event.type === "NEW_MESSAGE" &&
        (event as { metadata?: Record<string, unknown> }).metadata
            ?.goalPhase === "lead"
      ),
    );
  } finally {
    await copilotz.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("copilotz.goal does not hand target tool result messages to the lead by default", async () => {
  const tempDir = await Deno.makeTempDir();
  const copilotz = await createCopilotz({
    agents: [testedAgent, testerAgent],
    processors: [toolResultIsolationProcessor()],
    dbConfig: { url: `file://${tempDir}/goal-tool-isolation.db` },
  });

  try {
    const handle = await copilotz.goal({
      content: "I want a ticket",
      sender: {
        id: "client-03",
        type: "user",
        name: "Client Three",
        usingAgent: "tester",
      },
      target: "tested",
      thread: {
        externalId: "goal-tool-isolation-thread",
        participants: ["tested"],
      },
      maxTurns: 2,
    });

    for await (const _event of handle.events) {
      // Drain the live stream; assertions below use the final structured result.
    }

    const result = await handle.done;
    const leadUserMessage = result.transcript.find((message) =>
      message.phase === "lead" && message.senderType === "user"
    );
    const leadAgentMessage = result.transcript.find((message) =>
      message.phase === "lead" && message.senderType === "agent"
    );

    assertEquals(
      leadUserMessage?.content,
      "Which passenger details should I use?",
    );
    assertEquals(leadAgentMessage?.content, "TOOL_RESULT_NOT_VISIBLE");
    assert(
      result.transcript.some((message) =>
        message.phase === "target" &&
        message.senderType === "tool" &&
        message.content === "SECRET_TOOL_RESULT"
      ),
    );
  } finally {
    await copilotz.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("copilotz.goal evaluate callback can run a judge through Copilotz", async () => {
  const tempDir = await Deno.makeTempDir();
  const copilotz = await createCopilotz({
    agents: [testedAgent, testerAgent, judgeAgent],
    processors: [scriptedProcessor()],
    dbConfig: { url: `file://${tempDir}/goal-judge.db` },
  });

  try {
    const handle = await copilotz.goal({
      content: "I want a ticket",
      sender: {
        id: "client-02",
        type: "user",
        name: "Client Two",
        usingAgent: {
          ...testerAgent,
          id: "inline-tester",
          name: "inline-tester",
        },
      },
      target: "tested",
      thread: {
        externalId: "goal-main-thread-with-judge",
        participants: ["tested"],
      },
      maxTurns: 1,
      evaluate: async ({ run }) => {
        const judge = await run({
          content: "Judge this transcript",
          sender: { id: "goal", type: "system", name: "Goal" },
          target: "judge",
          thread: {
            externalId: "goal-judge-thread",
            participants: ["judge"],
          },
        });

        return {
          name: "judge",
          status: judge.text.includes("PASS") ? "completed" : "failed",
          score: 0.8,
          report: judge.text,
        };
      },
    });

    for await (const _event of handle.events) {
      // Drain the live stream; assertions below use the final structured result.
    }

    const result = await handle.done;

    assertEquals(result.status, "completed");
    assertEquals(result.score, 0.8);
    assertEquals(result.report, "PASS score=0.8");
    assertEquals(result.metrics.judgeRuns, 1);
    assert(
      result.events.some((event) =>
        event.type === "NEW_MESSAGE" &&
        (event as { metadata?: Record<string, unknown> }).metadata
            ?.goalPhase ===
          "judge"
      ),
    );
  } finally {
    await copilotz.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});
