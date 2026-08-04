import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";

import { createDatabase } from "@/database/index.ts";
import { setMemoryThreadMetadata } from "@/runtime/thread-metadata.ts";
import type { Agent, Event, ProcessorDeps } from "@/types/index.ts";
import { buildAgentLlmInput } from "./index.ts";

const BASE_INSTRUCTIONS = "Use the control booking guidance.";

type FixtureOptions = {
  instructionsResolver?: Agent["instructionsResolver"];
  userMetadata?: Record<string, unknown>;
  threadMetadata?: Record<string, unknown>;
};

async function createInputFixture(options: FixtureOptions = {}) {
  const db = await createDatabase({ url: ":memory:" });
  const suffix = crypto.randomUUID();
  const namespace = `agent-instructions-${suffix}`;
  const thread = await db.ops.mutate.threads.create(undefined, {
    namespace,
    name: "Instruction resolver test",
    participants: ["user", "assistant"],
    status: "active",
    mode: "immediate",
    metadata: options.threadMetadata,
  });
  const threadId = String(thread.id);

  await db.ops.mutate.messages.create({
    id: `message-${suffix}`,
    threadId,
    senderId: "user",
    senderType: "user",
    content: "I need a bus ticket.",
  }, namespace);

  const agent: Agent = {
    id: "assistant",
    name: "Assistant",
    role: "booking assistant",
    instructions: BASE_INSTRUCTIONS,
    instructionsResolver: options.instructionsResolver,
    llmOptions: { provider: "openai", model: "mock" },
  };
  const event = {
    id: `event-${suffix}`,
    type: "NEW_MESSAGE",
    threadId,
    payload: {},
  } as unknown as Event;
  const deps = {
    db,
    thread,
    context: {
      namespace,
      agents: [agent],
      userMetadata: options.userMetadata,
    },
    emitToStream: () => {},
  } as ProcessorDeps;

  return {
    agent,
    deps,
    event,
    thread,
    threadId,
    close: () => db.close(),
  };
}

function systemPrompt(input: Awaited<ReturnType<typeof buildAgentLlmInput>>) {
  const message = input.messages[0];
  assertEquals(message.role, "system");
  return String(message.content ?? "");
}

function variantFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const privateMetadata = metadata?._private as
    | Record<string, unknown>
    | undefined;
  const assignments = privateMetadata?.ab_tests as
    | Record<string, { variant?: unknown }>
    | undefined;
  const variant = assignments?.mobizap_agent_instructions_v1?.variant;
  return typeof variant === "string" ? variant : undefined;
}

Deno.test("buildAgentLlmInput instructionsResolver contract", async (t) => {
  const fixture = await createInputFixture({
    userMetadata: {
      _private: {
        ab_tests: { mobizap_agent_instructions_v1: { variant: "B" } },
      },
    },
    threadMetadata: setMemoryThreadMetadata(undefined, {
      identity: { userExternalId: "user-1" },
    }) as unknown as Record<string, unknown>,
  });

  try {
    await t.step(
      "resolves dynamic instructions without mutating the agent",
      async () => {
        let resolverCalls = 0;
        fixture.agent.instructionsResolver = ({
          agent,
          baseInstructions,
          sourceEvent,
          thread,
          userMetadata,
        }) => {
          resolverCalls += 1;
          assertEquals(agent, { id: "assistant", name: "Assistant" });
          assertEquals(baseInstructions, BASE_INSTRUCTIONS);
          assertEquals(thread.id, fixture.thread.id);
          assertEquals(sourceEvent.id, fixture.event.id);
          assertEquals(
            (userMetadata?._private as { ab_tests?: Record<string, unknown> })
              .ab_tests?.mobizap_agent_instructions_v1,
            { variant: "B" },
          );
          return "Use the candidate booking guidance.";
        };

        const input = await buildAgentLlmInput({
          deps: fixture.deps,
          event: fixture.event,
          threadId: fixture.threadId,
          agent: fixture.agent,
          historyMode: "full",
        });
        const prompt = systemPrompt(input);

        assertEquals(resolverCalls, 1);
        assertStringIncludes(prompt, "Use the candidate booking guidance.");
        assert(!prompt.includes(BASE_INSTRUCTIONS));
        assert(!prompt.includes("mobizap_agent_instructions_v1"));
        assertEquals(fixture.agent.instructions, BASE_INSTRUCTIONS);
      },
    );

    await t.step(
      "resolves LLM options after dynamic instructions",
      async () => {
        fixture.agent.instructionsResolver = () =>
          "Use the candidate booking guidance.";
        let sawResolvedInstructions = false;
        fixture.agent.llmOptions = ({ payload }) => {
          sawResolvedInstructions = String(payload.messages[0]?.content ?? "")
            .includes("Use the candidate booking guidance.");
          return {
            provider: "openai",
            model: "resolved-after-instructions",
          };
        };

        const input = await buildAgentLlmInput({
          deps: fixture.deps,
          event: fixture.event,
          threadId: fixture.threadId,
          agent: fixture.agent,
          historyMode: "full",
        });

        assert(sawResolvedInstructions);
        assertEquals(input.config.model, "resolved-after-instructions");
        fixture.agent.llmOptions = { provider: "openai", model: "mock" };
      },
    );

    await t.step(
      "keeps base instructions when the resolver returns undefined",
      async () => {
        fixture.agent.instructionsResolver = ({ baseInstructions }) => {
          assertEquals(baseInstructions, BASE_INSTRUCTIONS);
          return undefined;
        };

        const input = await buildAgentLlmInput({
          deps: fixture.deps,
          event: fixture.event,
          threadId: fixture.threadId,
          agent: fixture.agent,
          historyMode: "full",
        });

        assertStringIncludes(systemPrompt(input), BASE_INSTRUCTIONS);
      },
    );

    await t.step(
      "omits local instructions when the resolver returns null",
      async () => {
        fixture.agent.instructionsResolver = () => null;

        const input = await buildAgentLlmInput({
          deps: fixture.deps,
          event: fixture.event,
          threadId: fixture.threadId,
          agent: fixture.agent,
          historyMode: "full",
        });
        const prompt = systemPrompt(input);

        assert(!prompt.includes("Your instructions are:"));
        assert(!prompt.includes(BASE_INSTRUCTIONS));
      },
    );

    await t.step("rejects an invalid resolver result", async () => {
      fixture.agent.instructionsResolver = () => 42 as unknown as string;

      await assertRejects(
        () =>
          buildAgentLlmInput({
            deps: fixture.deps,
            event: fixture.event,
            threadId: fixture.threadId,
            agent: fixture.agent,
            historyMode: "full",
          }),
        TypeError,
        "must return a string, null, or undefined",
      );
    });

    await t.step(
      "propagates resolver failures before provider resolution",
      async () => {
        fixture.agent.instructionsResolver = () => {
          throw new Error("instruction source unavailable");
        };
        let providerResolverCalled = false;
        fixture.agent.llmOptions = () => {
          providerResolverCalled = true;
          return { provider: "openai", model: "must-not-run" };
        };

        await assertRejects(
          () =>
            buildAgentLlmInput({
              deps: fixture.deps,
              event: fixture.event,
              threadId: fixture.threadId,
              agent: fixture.agent,
              historyMode: "full",
            }),
          Error,
          "instruction source unavailable",
        );
        assertEquals(providerResolverCalled, false);
        fixture.agent.llmOptions = { provider: "openai", model: "mock" };
      },
    );

    await t.step(
      "refreshes runtime participant metadata between prompts",
      async () => {
        delete fixture.deps.context.userMetadata;
        let participantLookups = 0;
        let persistedMetadata: Record<string, unknown> = {
          profile: { locale: "pt-BR" },
        };
        fixture.deps.context.collections = {
          participant: {
            resolveByExternalId: (externalId: string) => {
              if (externalId !== "user-1") return Promise.resolve(null);
              participantLookups += 1;
              return Promise.resolve({
                id: "participant-user-1",
                externalId,
                metadata: structuredClone(persistedMetadata),
              });
            },
          },
        } as never;

        const variantsSeen: Array<string | undefined> = [];
        fixture.agent.instructionsResolver = ({ userMetadata }) => {
          const variant = variantFromMetadata(userMetadata);
          variantsSeen.push(variant);
          return variant === "B"
            ? "Use the candidate booking guidance."
            : undefined;
        };

        const beforeAssignment = await buildAgentLlmInput({
          deps: fixture.deps,
          event: fixture.event,
          threadId: fixture.threadId,
          agent: fixture.agent,
          historyMode: "full",
        });

        persistedMetadata = {
          profile: { locale: "pt-BR" },
          _private: {
            ab_tests: {
              mobizap_agent_instructions_v1: {
                variant: "B",
                assignedAt: 1,
                version: 1,
                algorithm: "sha256-first-byte-2arm-v1",
              },
            },
          },
        };

        const afterAssignment = await buildAgentLlmInput({
          deps: fixture.deps,
          event: fixture.event,
          threadId: fixture.threadId,
          agent: fixture.agent,
          historyMode: "full",
        });

        assertEquals(participantLookups, 2);
        assertEquals(variantsSeen, [undefined, "B"]);
        assertStringIncludes(systemPrompt(beforeAssignment), BASE_INSTRUCTIONS);
        assertStringIncludes(
          systemPrompt(afterAssignment),
          "Use the candidate booking guidance.",
        );
        assert(
          !systemPrompt(afterAssignment).includes(
            "mobizap_agent_instructions_v1",
          ),
        );
        assertEquals(
          variantFromMetadata(fixture.deps.context.userMetadata),
          "B",
        );
        assertEquals(fixture.agent.id, "assistant");
      },
    );

    await t.step(
      "preserves explicit userMetadata over participant refresh",
      async () => {
        const explicitMetadata = { tenantFlag: "provided" };
        fixture.deps.context.userMetadata = explicitMetadata;
        let participantLookups = 0;
        fixture.deps.context.collections = {
          participant: {
            resolveByExternalId: (externalId: string) => {
              if (externalId === "user-1") participantLookups += 1;
              return Promise.resolve({
                id: `participant-${externalId}`,
                externalId,
                metadata: { tenantFlag: "participant" },
              });
            },
          },
        } as never;

        let metadataSeen: Record<string, unknown> | undefined;
        fixture.agent.instructionsResolver = ({ userMetadata }) => {
          metadataSeen = userMetadata as Record<string, unknown> | undefined;
          return undefined;
        };

        await buildAgentLlmInput({
          deps: fixture.deps,
          event: fixture.event,
          threadId: fixture.threadId,
          agent: fixture.agent,
          historyMode: "full",
        });

        assertEquals(participantLookups, 0);
        assertEquals(metadataSeen, explicitMetadata);
        assertEquals(fixture.deps.context.userMetadata, explicitMetadata);
      },
    );
  } finally {
    await fixture.close();
  }
});
