/**
 * Opt-in live-provider regression, disabled in normal test runs.
 * With OPENAI_API_KEY already in the environment, run:
 * COPILOTZ_LIVE_MEMORY_TEST=1 COPILOTZ_LIVE_TEST_DATABASE_URL=<local PostgreSQL URL>
 * deno test -A plugins/memory/shared/live-provider.test.ts
 *
 * Uses synthetic history, a fresh temporary schema, and at most eight provider
 * requests. Only loopback PostgreSQL is accepted. COPILOTZ_LIVE_TEST_MODEL may
 * override the default model. Never put a credential in this file or test logs.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { defineAgent, loadThreadRecord } from "@copilotz/copilotz/core";
import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import { validateCollectionIndexes } from "@copilotz/copilotz/collections";
import type { StreamOutput } from "@copilotz/copilotz/streams";
import { createCopilotzEngine } from "../../../runtime/engine/index.ts";
import { createTestDatabase } from "../../../runtime/testing/ominipg.ts";
import { createTestDomainContext } from "../../core/shared/testing/context.ts";
import { projectMessages } from "../../core/shared/testing/projections.ts";
import { memoryPlugin } from "../plugin.ts";
import { checkpointHead, readyCheckpoint } from "./checkpoints.ts";

Deno.test({
  name:
    "live OpenAI: numeric checkpoint selection, foreground consolidation, and resumed turns",
  ignore: Deno.env.get("COPILOTZ_LIVE_MEMORY_TEST") !== "1",
  async fn() {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    assert(
      apiKey,
      "OPENAI_API_KEY is required for this explicitly enabled test",
    );
    const url = Deno.env.get("COPILOTZ_LIVE_TEST_DATABASE_URL");
    assert(url, "An isolated local PostgreSQL URL is required");
    assertEquals(new URL(url).hostname, "127.0.0.1");
    const model = Deno.env.get("COPILOTZ_LIVE_TEST_MODEL") ?? "gpt-6.1-sol";
    const schema = `memory_live_${crypto.randomUUID().replaceAll("-", "")}`;
    const namespace = "synthetic-live-test";
    const threadId = "development-fixture";
    const participantId = "agent-north";
    const inputs: { maintenance: boolean; body: string; status: number }[] = [];
    const streams: StreamOutput[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).hostname === "openrouter.ai") {
        return originalFetch(request);
      }
      assertEquals(new URL(request.url).hostname, "api.openai.com");
      assert(inputs.length < 8, "Live test exceeded its eight-request limit");
      // Only synthetic request bodies are retained; never capture auth headers.
      const body = await request.clone().text();
      const observation = {
        maintenance: body.includes("Internal memory maintenance"),
        body,
        status: 0,
      };
      inputs.push(observation);
      const response = await originalFetch(request, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
      });
      observation.status = response.status;
      console.log(JSON.stringify({
        providerRequest: inputs.length,
        maintenance: observation.maintenance,
        status: response.status,
      }));
      return response;
    };
    const db = await createTestDatabase({ url });
    const registry = await createPluginRegistry({
      plugins: [memoryPlugin],
      resources: {
        agents: {
          north: defineAgent({
            id: "north",
            name: "North",
            role: "assistant",
            instructions:
              "You are North in a synthetic integration test. Follow internal memory maintenance instructions. All fixture facts are ephemeral: consolidate continuity with outcome no_changes and no semantic records. Preserve the exact release code from existing continuity and the exact launch color from history in any replacement continuity. For ordinary questions answer concisely with the requested facts. Do not call tools during ordinary replies.",
            models: {
              generate: [{
                connection: "openai_service",
                model,
                options: {
                  reasoningEffort: "low",
                  maxTokens: 4_000,
                  limitEstimatedInputTokens: 40_000,
                },
              }],
            },
            capabilities: { tools: ["consolidate_memory"] },
          }),
        },
        llmConnections: {
          openai_service: {
            provider: "openai",
            auth: { resolve: () => ({ available: true, apiKey }) },
          },
        },
        memory: {
          config: {
            // Force foreground compaction through the model admission budget;
            // leave ordinary background consolidation disabled by its threshold.
            triggerEstimatedTokens: 999_999,
            retainRecentEstimatedTokens: 1_000,
          },
        },
      },
    });
    let engine: Awaited<ReturnType<typeof createCopilotzEngine>> | undefined;
    const start = Date.now();
    try {
      engine = await createCopilotzEngine({
        session: db,
        registry,
        defaultDatabaseSchema: schema,
        retryBaseMs: 0,
      });
      await validateCollectionIndexes(
        db,
        schema,
        Object.values(registry.collections),
      );
      // Compass serves already-provisioned tenant schemas: exercise that path too.
      await engine.shutdown();
      engine = await createCopilotzEngine({
        session: db,
        registry,
        defaultDatabaseSchema: schema,
        provisionDefaultDatabaseSchema: false,
        retryBaseMs: 0,
        publishLocalStream: (output) => {
          streams.push(output);
        },
      });
      const context = createTestDomainContext(engine, namespace);
      await context.collections.participant.create({
        id: "human",
        externalId: "human",
        participantType: "human",
      });
      await context.collections.participant.create({
        id: participantId,
        externalId: "north",
        participantType: "agent",
        agentId: "north",
        name: "North",
      });
      await context.collections.thread.create({
        id: threadId,
        participantIds: ["human", participantId],
      });
      const message = async (id: string, text: string, dispatch = false) => {
        const content = await engine!.content.preparer.prepare(text, {
          namespace,
          idempotencyKey: `${id}:content`,
        });
        return await context.collections.message.create({
          id,
          threadId,
          senderId: "human",
          recipientIds: dispatch ? [participantId] : [],
          content,
          metadata: {},
        }, {
          metadata: {
            core: {
              threadId,
              routing: {
                senderId: "human",
                recipientIds: dispatch ? [participantId] : [],
              },
            },
          },
          identity: { deduplicationId: `${id}:create` },
        });
      };
      for (const sequence of [9, 10, 40]) {
        const boundary = `message:boundary:${sequence}`;
        await message(boundary, `ARCHIVED_ONLY_${sequence}`);
        await context.collections.longTermMemory.create({
          id: `memory:${threadId}:north:${sequence}`,
          threadId,
          agentId: "north",
          schemaVersion: "4",
          strategy: "semantic_graph",
          status: "ready",
          sequence,
          sourceStartMessageId: boundary,
          sourceEndMessageId: boundary,
          metadata: {
            coverage: {
              schema: "copilotz.memory.coverage.v1",
              agentParticipantId: participantId,
              branch: "public",
              startMessageId: boundary,
              endMessageId: boundary,
              continuity: sequence === 40
                ? "The ephemeral release code is ORCHID-40."
                : `OBSOLETE_CONTINUITY_${sequence}`,
            },
          },
        });
      }
      const thread = await loadThreadRecord(context, threadId);
      assert(thread);
      const latest = () =>
        readyCheckpoint(context as never, {
          thread,
          agentId: "north",
          participantId,
        });
      assertEquals(
        (await checkpointHead(context as never, threadId, "north"))?.sequence,
        40,
      );
      assertEquals((await latest())?.sequence, 40);
      for (let index = 0; index < 18; index++) {
        await message(
          `message:history:${index}`,
          `HISTORY_${index} The ephemeral launch color is cobalt. ${
            "Synthetic routine progress; no durable facts. ".repeat(180)
          }`,
        );
      }
      await message(
        "message:current",
        "CURRENT_TAIL What are the release code and launch color?",
        true,
      );
      const replies = async () => {
        const messages = (await projectMessages(engine!, namespace, threadId))
          .filter((m) => m.sender.id === participantId);
        const texts = await Promise.all(messages.map(async (m) => {
          const content = await engine!.content.resolver.getMany(m.content, {
            namespace,
          });
          return content.map((part) => part.text ?? "").join("");
        }));
        return texts.filter((text) => text.includes("ORCHID-40"));
      };
      const waitForReplies = async (count: number) => {
        const deadline = Date.now() + 240_000;
        while (Date.now() < deadline) {
          const actionFailures = await db.query(
            `SELECT body->'error' AS error FROM "${schema}".event_bodies WHERE body->>'status'='failed'`,
          );
          assertEquals(actionFailures.rows, [], "No durable Action may fail");
          const dead = await engine!.deliveries.list({
            namespace,
            status: "dead_letter",
          });
          assertEquals(
            dead.map((d) => d.lastError),
            [],
            "The real-provider turn must not dead-letter",
          );
          const failed = await context.collections.longTermMemory.list({
            where: { status: "failed" },
          });
          assertEquals(
            failed.map((c) => c.error),
            [],
            "Consolidation must succeed",
          );
          if ((await replies()).length >= count) {
            const pending = await engine!.deliveries.list({
              namespace,
              status: "pending",
            });
            const running = await engine!.deliveries.list({
              namespace,
              status: "leased",
            });
            if (!pending.length && !running.length) return;
          }
          await engine!.recover({ namespace });
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throw new Error(
          "Live memory test timed out before the ordinary reply settled",
        );
      };
      await waitForReplies(1);
      const saved = await latest();
      assert(saved && Number(saved.sequence) > 40);
      assert(saved.sourceEndMessageId !== "message:boundary:40");
      assert(saved.sourceEndMessageId !== "message:current");
      assertEquals(
        inputs[0].maintenance,
        true,
        "The waiting turn must compact before its ordinary model call",
      );
      assert(inputs.every((i) => i.status === 200));
      const maintenance = inputs.filter((i) => i.maintenance);
      const ordinary = inputs.filter((i) => !i.maintenance);
      assert(maintenance.length >= 1);
      assertEquals(ordinary.length, 1);
      for (const input of inputs) {
        assertStringIncludes(input.body, "ORCHID-40");
        assert(!input.body.includes("OBSOLETE_CONTINUITY_"));
        assert(!input.body.includes("ARCHIVED_ONLY_"));
      }
      assert(!maintenance[0].body.includes("CURRENT_TAIL"));
      assertStringIncludes(ordinary[0].body, "CURRENT_TAIL");
      const ordinaryWire = JSON.parse(ordinary[0].body);
      const ordinaryHistory = JSON.stringify(
        (ordinaryWire.input ?? ordinaryWire.messages).filter(
          (message: { role?: string }) =>
            message.role !== "system" && message.role !== "developer",
        ),
      );
      // The summary may mention a source marker; the original message must
      // disappear from the actual history, not from the replacement summary.
      assert(
        !ordinaryHistory.includes("HISTORY_0 "),
        "Compacted source must not remain in the model history",
      );
      const answer = (await replies())[0];
      assertStringIncludes(answer.toLowerCase(), "cobalt");
      await message(
        "message:follow-up",
        "FOLLOW_UP Confirm the same release code and launch color once more.",
        true,
      );
      await waitForReplies(2);
      assertEquals(
        (await latest())?.sequence,
        saved.sequence,
        "A subsequent small turn must reuse the new checkpoint",
      );
      assertEquals(
        inputs.filter((i) => i.maintenance).length,
        maintenance.length,
      );
      assert(
        streams.length > 0,
        "Real provider frames must reach the stream publisher",
      );
      let streamedBytes = 0;
      for (const stream of streams) {
        streamedBytes +=
          (await new Response(stream.payload).arrayBuffer()).byteLength;
        assertEquals((await stream.terminal).outcome, "completed");
      }
      assert(streamedBytes > 0);
      console.log(JSON.stringify({
        model,
        database: "local PostgreSQL",
        checkpointBefore: 40,
        checkpointAfter: saved.sequence,
        providerCalls: inputs.length,
        consolidationCalls: maintenance.length,
        ordinaryReplies: (await replies()).length,
        streamedBytes,
        elapsedMs: Date.now() - start,
        answer,
      }));
    } finally {
      await engine?.shutdown();
      globalThis.fetch = originalFetch;
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.close();
    }
  },
});
