import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Agent } from "../resources/index.ts";
import type { ConversationThread, Participant } from "../domain/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import {
  collectContextContributions,
  defineContextResource,
  renderContextContent,
} from "./index.ts";

const agent: Agent = {
  id: "north",
  name: "North",
  role: "assistant",
};

const participant = {
  id: "participant-north",
  namespace: "tenant-a",
  externalId: "north",
  participantType: "agent",
  agentId: "north",
  metadata: {},
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
} as const satisfies Participant;

const thread = {
  id: "thread-a",
  namespace: "tenant-a",
  status: "active",
  metadata: {},
  participants: [participant],
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
} as const satisfies ConversationThread;

function context(
  resources: readonly ReturnType<typeof defineContextResource>[],
): CopilotzProcessorContext {
  return {
    resources: {
      promptContext: Object.fromEntries(
        resources.map((resource) => [resource.id, resource]),
      ),
    },
    adapters: {},
    collections: { workspace: {} },
    signal: new AbortController().signal,
    idempotencyKey: "delivery-a",
    content: {
      resolve: () =>
        Promise.resolve({
          text: "resolved asset text",
          bytes: new Uint8Array(),
          ref: {
            assetId: "asset-a",
            kind: "text",
            role: "context",
            mediaType: "text/plain",
          },
        }),
    },
  } as unknown as CopilotzProcessorContext;
}

Deno.test("context resources are purpose-scoped, ordered, and receive stable capabilities", async () => {
  const observed: unknown[] = [];
  const conversation = defineContextResource({
    id: "app.conversation",
    type: "context",
    purposes: ["conversation"],
    contribute: () => ({
      id: "conversation",
      title: "Conversation state",
      role: "context",
      content: "conversation only",
    }),
  });
  const workspace = defineContextResource({
    id: "app.workspace",
    type: "context",
    purposes: ["conversation", "memory_consolidation"],
    contribute(input) {
      observed.push(input);
      return [{
        id: "document",
        title: "Shared document",
        role: "evidence",
        content: { type: "text", text: "version seven" },
        source: {
          type: "collection_record",
          collection: "sharedDocument",
          id: "doc-a",
          version: 7,
        },
      }, {
        id: "board",
        title: "Kanban board",
        role: "context",
        content: { type: "json", value: { cards: 2 } },
      }];
    },
  });
  const processor = context([conversation, workspace]);
  const values = await collectContextContributions(processor, {
    purpose: "memory_consolidation",
    agent,
    participant,
    thread,
    sourceRange: {
      startMessageId: "message-a",
      endMessageId: "message-b",
      messages: [],
    },
  });

  assertEquals(values.map((value) => value.id), ["document", "board"]);
  const input = observed[0] as Record<string, unknown>;
  assertEquals(
    input.idempotencyKey,
    "delivery-a:context:app.workspace:memory_consolidation",
  );
  assertEquals(input.collections, processor.collections);
  assertEquals(
    (input.sourceRange as Record<string, unknown>).endMessageId,
    "message-b",
  );
});

Deno.test("context contribution contracts reject ambiguity and unproven evidence", async () => {
  assertThrows(
    () =>
      defineContextResource({
        id: "invalid",
        type: "context",
        purposes: [],
        contribute: () => null,
      }),
    TypeError,
    "purpose",
  );
  const duplicate = defineContextResource({
    id: "duplicate",
    type: "context",
    purposes: ["conversation"],
    contribute: () => [{
      id: "same",
      title: "A",
      role: "context",
      content: "a",
    }, {
      id: "same",
      title: "B",
      role: "context",
      content: "b",
    }],
  });
  await assertRejects(
    () =>
      collectContextContributions(context([duplicate]), {
        purpose: "conversation",
        agent,
        participant,
        thread,
      }),
    TypeError,
    "Duplicate",
  );
  const missingSource = defineContextResource({
    id: "missing-source",
    type: "context",
    purposes: ["memory_consolidation"],
    contribute: () => ({
      id: "evidence",
      title: "Unsupported evidence",
      role: "evidence",
      content: "value",
    }),
  });
  await assertRejects(
    () =>
      collectContextContributions(context([missingSource]), {
        purpose: "memory_consolidation",
        agent,
        participant,
        thread,
      }),
    TypeError,
    "requires a source",
  );
});

Deno.test("context rendering resolves text, JSON, and canonical content refs", async () => {
  const processor = context([]);
  assertEquals(await renderContextContent(processor, "plain"), "plain");
  assertEquals(
    await renderContextContent(processor, {
      type: "json",
      value: { state: "active" },
    }),
    '{\n  "state": "active"\n}',
  );
  assertEquals(
    await renderContextContent(processor, {
      assetId: "asset-a",
      kind: "text",
      role: "context",
      mediaType: "text/plain",
    }),
    "resolved asset text",
  );
});

Deno.test("context modules remain factory-first and runtime-neutral", async () => {
  for (const module of ["types.ts", "resources.ts", "contributions.ts"]) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assertEquals(/\bclass\s+\w+/.test(source), false, module);
    assertEquals(/\bDeno\b|\bBun\b|\bprocess\b/.test(source), false, module);
    assertEquals(/from\s+["']node:/.test(source), false, module);
  }
});
