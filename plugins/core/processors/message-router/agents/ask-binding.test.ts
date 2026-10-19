/** Initial Ask provider input is bound to its canonical routed question. @module */
import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
  CollectionQuery,
  CollectionRecord,
  ScopedCollection,
} from "@copilotz/copilotz/collections";
import type { LlmCallInput, LlmMessage } from "@copilotz/copilotz/llm";
import { matchesCollectionFilter } from "../../../../../runtime/collections/predicate.ts";
import { messageRouterProcessor } from "../index.ts";
import { defineContextResource } from "../../../authoring/define-context/index.ts";
import {
  type AgentAskMetadata,
  type CoreToolActionOrigin,
  withAgentAskMetadata,
  withCoreAgentTurnMetadata,
  withCoreToolActionMessageMetadata,
  withCoreToolPlanMetadata,
  withWorkflowMetadata,
} from "../../../shared/workflow-metadata.ts";

const namespace = "ask-binding";
const threadId = "shared-thread";
const timestamp = (n: number) =>
  new Date(Date.UTC(2026, 9, 19, 0, 0, n)).toISOString();
const origin: CoreToolActionOrigin = {
  schema: "copilotz.core.tool-action.v1",
  planId: "plan",
  planMessageId: "plan-message",
  planIndex: 0,
  stageIndex: 0,
  stageCount: 1,
  planSize: 2,
  toolCallId: "ask-alpha",
  action: "ask",
  threadId,
  triggerMessageId: "ordinary",
  agentId: "north",
  agentParticipantId: "north",
  initiatorParticipantId: "human",
  availableToolIds: ["ask"],
  responseVisibility: { kind: "public" },
  parentLlmActionRunId: "north-run",
};
function ask(key: string): AgentAskMetadata {
  return {
    schema: "copilotz.ask.v1",
    askId: `ask-${key}`,
    phase: "question",
    mode: "public",
    toolActionRunId: `ask-run-${key}`,
    toolCallId: `ask-${key}`,
    questionMessageId: key,
    askingParticipantId: "north",
    askingAgentId: "north",
    askedParticipantId: "west",
    askedAgentId: "west",
    origin: { ...origin, toolCallId: `ask-${key}` },
    depth: 1,
  };
}
const participant = (id: string, kind = "agent") => ({
  id,
  namespace,
  externalId: id,
  ...(kind === "agent" ? { agentId: id } : {}),
  participantType: kind,
  name: id,
  metadata: {},
  createdAt: timestamp(0),
  updatedAt: timestamp(0),
});
const participants = [
  participant("human", "human"),
  participant("north"),
  participant("west"),
  participant("east"),
  participant("tool", "tool"),
];
const thread = {
  id: threadId,
  namespace,
  participantIds: participants.map((p) => p.id),
  metadata: {},
  status: "active",
  createdAt: timestamp(0),
  updatedAt: timestamp(9),
};
function message(
  id: string,
  index: number,
  senderId = "north",
): CollectionRecord {
  return {
    id,
    namespace,
    threadId,
    senderId,
    recipientIds: ["west"],
    content: [
      {
        assetId: `${id}-text`,
        kind: "text",
        role: "body",
        mediaType: "text/plain",
      },
      {
        assetId: `${id}-json`,
        kind: "json",
        role: "body",
        mediaType: "application/json",
      },
    ],
    metadata: id === "alpha" || id === "beta"
      ? withAgentAskMetadata({}, ask(id))
      : {},
    visibility: { kind: "public" },
    createdAt: timestamp(index),
    updatedAt: timestamp(index),
  };
}
const values = (id: string) =>
  id.endsWith("-text")
    ? `QUESTION=${id.slice(0, -5)} Ω <untrusted>`
    : { key: id.slice(0, -5), parts: [1, 2] };
const textValues = (messages: readonly LlmMessage[]) =>
  messages.map((m) => m.content.map((p) => "value" in p ? p.value : undefined));

function fixture(source: readonly CollectionRecord[], options: {
  after?: string;
  denied?: string;
  branch?: { rootMessageId: string; headMessageId: string };
  mutate?: (records: Map<string, CollectionRecord>) => void;
} = {}) {
  const records = new Map(source.map((r) => [r.id, structuredClone(r)]));
  options.mutate?.(records);
  const queries: { query: CollectionQuery; inSnapshot: boolean }[] = [];
  const prepared: { input: LlmCallInput; metadata: Record<string, unknown> }[] =
    [];
  const histories: string[][] = [];
  let snapshotDepth = 0;
  function collection(
    items: () => readonly CollectionRecord[],
    isMessage = false,
  ): ScopedCollection {
    return {
      get({ id }: { id: string }) {
        return Promise.resolve(
          structuredClone(items().find((r) => r.id === id) ?? null),
        );
      },
      list(query: CollectionQuery = {}) {
        if (isMessage) {
          queries.push({
            query: structuredClone(query),
            inSnapshot: snapshotDepth > 0,
          });
        }
        let selected = items().filter((r) =>
          (!isMessage || r.id !== options.denied) &&
          matchesCollectionFilter(query, r)
        );
        selected.sort((a, b) => {
          const field = query.order?.field ?? "id";
          const order = String(a[field]).localeCompare(String(b[field])) ||
            a.id.localeCompare(b.id);
          return query.order?.direction === "desc" ? -order : order;
        });
        if (query.after) {
          selected = selected.slice(
            selected.findIndex((r) => r.id === query.after) + 1,
          );
        }
        if (query.before) {
          selected = selected.slice(
            0,
            selected.findIndex((r) => r.id === query.before),
          );
        }
        return Promise.resolve(structuredClone(selected.slice(0, query.limit)));
      },
    } as unknown as ScopedCollection;
  }
  const collections = {
    message: collection(() => [...records.values()], true),
    participant: collection(() => participants),
    thread: collection(() => [{
      ...thread,
      ...(options.branch ? { activeMessageBranch: options.branch } : {}),
    }]),
  };
  const agents = Object.fromEntries(["north", "west", "east"].map((id) => [id, {
    id,
    name: id,
    role: "assistant",
    instructions: `ACTIVE_AGENT=${id}`,
    models: { generate: [{ connection: "test", model: "synthetic" }] },
  }]));
  const context = {
    namespace,
    signal: new AbortController().signal,
    identity: { settlementScopeId: "test" },
    collections,
    async readSnapshot(
      run: (value: { collections: typeof collections }) => Promise<unknown>,
    ) {
      snapshotDepth++;
      try {
        return await run({ collections });
      } finally {
        snapshotDepth--;
      }
    },
    resources: {
      agents,
      llmConnections: { test: { adapter: "synthetic" } },
      capabilities: { default: { resolve: () => ({ tools: [] }) } },
      promptContext: {
        history: defineContextResource({
          id: "test.ask-history",
          type: "context",
          purposes: ["conversation"],
          contribute: () =>
            options.after
              ? [{
                id: "boundary",
                title: "memory",
                role: "context",
                content: { type: "text", text: "bounded" },
                historyAfterMessageId: options.after,
              }]
              : [],
          onHistoryPrepared: ({ transcript }) => {
            histories.push(transcript!.map((entry) => entry.sourceId));
          },
        }),
      },
    },
    content: {
      getMany: (ids: readonly string[]) =>
        Promise.resolve(ids.map((id) => ({ id, byteLength: 128 }))),
      resolveMany: (refs: readonly { assetId: string }[]) =>
        Promise.resolve(
          refs.map((ref) => ({
            ...ref,
            text: values(ref.assetId),
            value: values(ref.assetId),
          })),
        ),
    },
    actions: {
      callLlm: {
        async prepare(
          run: () => Promise<
            { input: LlmCallInput; metadata: Record<string, unknown> }
          >,
        ) {
          prepared.push(await run());
        },
      },
    },
  } as unknown as Parameters<typeof messageRouterProcessor.handle>[1];
  async function route(
    record: CollectionRecord,
    recipient = "west",
    eventThreadId = threadId,
  ) {
    await messageRouterProcessor.handle(
      {
        id: `event-${record.id}`,
        durable: true,
        correlationId: "correlation",
        metadata: {
          core: {
            threadId: eventThreadId,
            routing: { recipientIds: [recipient] },
            visibility: structuredClone(record.visibility),
          },
        },
        data: {
          record: { ...structuredClone(record), recipientIds: [recipient] },
        },
      } as unknown as Parameters<typeof messageRouterProcessor.handle>[0],
      context,
    );
  }
  return { route, prepared, histories, queries, records };
}

for (const reverse of [false, true]) {
  Deno.test(`initial same-Agent Asks keep their own question once (${reverse ? "reverse" : "forward"} dispatch)`, async () => {
    const alpha = message("alpha", reverse ? 2 : 1);
    const beta = message("beta", reverse ? 1 : 2);
    const latest = message("latest", 3, "human");
    const chronological = [alpha, beta].sort((a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt))
    ).concat(latest);
    const f = fixture(chronological);
    await Promise.all(
      (reverse ? [beta, alpha] : [alpha, beta]).map((q) => f.route(q)),
    );
    assertEquals(f.prepared.length, 2);
    for (const call of f.prepared) {
      const id = call.metadata.triggerMessageId as string;
      const messages = call.input.request.messages;
      assertEquals(textValues(messages).at(-1), [
        values(`${id}-text`),
        values(`${id}-json`),
      ]);
      assertEquals(messages.at(-1)?.role, "user");
      assertEquals(
        messages.flatMap((m) => m.content).filter((p) =>
          p.assetId === `${id}-text`
        ).length,
        1,
      );
      assertEquals(messages.length, 3);
      assert(
        textValues(messages).some((parts) =>
          parts[0] === values("latest-text")
        ),
      );
      assert(!call.input.request.instructions?.includes("<untrusted>"));
    }
    assertEquals(f.histories, [
      chronological.map((m) => m.id),
      chronological.map((m) => m.id),
    ]);
  });
}

Deno.test("initial Ask outside certified history uses only its authorized exact point", async () => {
  const alpha = message("alpha", 1),
    beta = message("beta", 2),
    latest = message("latest", 3, "human");
  const f = fixture([alpha, beta, latest], { after: "beta" });
  await f.route(alpha);
  assertEquals(textValues(f.prepared[0].input.request.messages), [
    [values("latest-text"), values("latest-json")],
    [values("alpha-text"), values("alpha-json")],
  ]);
  assertEquals(f.histories, [["latest"]]);
  const points = f.queries.filter(({ query }) => query.where?.id);
  assertEquals(points.map(({ query }) => query.where), [{
    threadId,
    id: "alpha",
  }]);
  assert(points.every((entry) => entry.inSnapshot));
});

Deno.test("initial Ask never restores a denied point outside bounded history", async () => {
  const alpha = message("alpha", 1),
    beta = message("beta", 2),
    latest = message("latest", 3, "human");
  const f = fixture([alpha, beta, latest], { after: "beta", denied: "alpha" });
  await assertRejects(
    () => f.route(alpha),
    Error,
    "does not match its routed identity",
  );
  assertEquals(f.prepared, []);
});

Deno.test("missing and hidden initial Ask questions never reach the provider", async () => {
  const alpha = message("alpha", 1), latest = message("latest", 3, "human");
  for (const hidden of [false, true]) {
    const f = fixture([alpha, latest], {
      mutate(records) {
        if (!hidden) records.delete("alpha");
        else {records.set("alpha", {
            ...alpha,
            visibility: { kind: "participants", participantIds: ["east"] },
          });}
      },
    });
    if (hidden) {
      await assertRejects(
        () => f.route(alpha),
        Error,
        "does not match its routed identity",
      );
    } else await f.route(alpha);
    assertEquals(f.prepared, []);
  }
});

Deno.test("initial Ask current identity, recipient, namespace and trigger mismatches refuse", async () => {
  const alpha = message("alpha", 1), beta = message("beta", 2);
  const mutations: ((record: CollectionRecord) => CollectionRecord)[] = [
    (r) => ({
      ...r,
      metadata: withAgentAskMetadata({}, {
        ...ask("alpha"),
        askId: "substituted",
      }),
    }),
    (r) => ({
      ...r,
      metadata: withAgentAskMetadata({}, {
        ...ask("alpha"),
        askedParticipantId: "east",
      }),
    }),
    (r) => ({
      ...r,
      metadata: withAgentAskMetadata({}, {
        ...ask("alpha"),
        askedAgentId: "east",
      }),
    }),
    (r) => ({
      ...r,
      metadata: withAgentAskMetadata({}, {
        ...ask("alpha"),
        askingParticipantId: "east",
      }),
    }),
    (r) => ({
      ...r,
      metadata: withAgentAskMetadata({}, {
        ...ask("alpha"),
        origin: { ...origin, threadId: "other" },
      }),
    }),
    (r) => ({ ...r, namespace: "other" }),
    (r) => ({ ...r, recipientIds: ["east"] }),
  ];
  for (const mutate of mutations) {
    const f = fixture([alpha, beta], {
      mutate: (records) => records.set("alpha", mutate(alpha)),
    });
    await assertRejects(
      () => f.route(alpha),
      Error,
      "does not match its routed identity",
    );
    assertEquals(f.prepared, []);
  }
  const bad = {
    ...alpha,
    metadata: withAgentAskMetadata({}, {
      ...ask("alpha"),
      questionMessageId: "beta",
    }),
  };
  const f = fixture([bad, beta]);
  await assertRejects(() => f.route(bad), Error, "different trigger");
  assertEquals(f.prepared, []);
});

Deno.test("ordinary delayed trigger still uses the latest authorized tail", async () => {
  const ordinary = message("ordinary", 0, "human"),
    alpha = message("alpha", 1),
    latest = message("latest", 3, "human");
  const f = fixture([ordinary, alpha, latest], { after: "alpha" });
  await f.route(ordinary);
  assertEquals(textValues(f.prepared[0].input.request.messages), [[
    values("latest-text"),
    values("latest-json"),
  ]]);
  assertEquals(f.queries.filter(({ query }) => query.where?.id), []);
});

Deno.test("Ask Tool continuation retains assistant-call and Tool-result order", async () => {
  const alpha = message("alpha", 1);
  const plan = {
    ...message("tool-plan", 2, "west"),
    metadata: withCoreToolPlanMetadata({
      llmToolCalls: [{ id: "lookup", action: "lookup", input: {} }],
    }, {
      schema: "copilotz.core.tool-plan.v1",
      planId: "lookup-plan",
      planSize: 1,
    }),
  };
  const cursor = {
    ...origin,
    action: "lookup",
    planId: "lookup-plan",
    planSize: 1,
    toolCallId: "lookup",
    agentId: "west",
    agentParticipantId: "west",
    ask: ask("alpha"),
  };
  const result = {
    ...message("tool-result", 3, "tool"),
    metadata: withCoreToolActionMessageMetadata(
      withWorkflowMetadata({ requesterId: "west" }, {
        kind: "tool_result",
        agentId: "west",
        agentParticipantId: "west",
        continuation: "text",
      }),
      cursor,
      "lookup-run",
    ),
  };
  const f = fixture([alpha, plan, result]);
  await f.route(result);
  assertEquals(f.prepared[0].input.request.messages.map((m) => m.role), [
    "user",
    "assistant",
    "tool",
  ]);
  assertEquals(textValues(f.prepared[0].input.request.messages).at(-1), [
    values("tool-result-text"),
    values("tool-result-json"),
  ]);
  assertEquals(f.histories, [["alpha", "tool-plan", "tool-result"]]);
});

Deno.test("initial Ask event thread and routed recipient substitutions refuse", async () => {
  const alpha = message("alpha", 1), beta = message("beta", 2);
  const f = fixture([alpha, beta]);
  await assertRejects(
    () => f.route(alpha, "west", "other-thread"),
    Error,
    "different trigger",
  );
  await assertRejects(
    () => f.route(alpha, "east"),
    Error,
    "does not match its routed identity",
  );
  assertEquals(f.prepared, []);
});

Deno.test("an authorized private initial Ask still carries its canonical parts once", async () => {
  const alpha = {
    ...message("alpha", 1),
    metadata: withAgentAskMetadata({}, { ...ask("alpha"), mode: "private" }),
    visibility: { kind: "participants", participantIds: ["north", "west"] },
  };
  const latest = message("latest", 3, "human");
  const f = fixture([alpha, latest]);
  await f.route(alpha);
  assertEquals(textValues(f.prepared[0].input.request.messages), [
    [values("latest-text"), values("latest-json")],
    [values("alpha-text"), values("alpha-json")],
  ]);
});

function internalQuestion(history?: "scope"): CollectionRecord {
  return {
    ...message("alpha", 1),
    visibility: { kind: "internal" },
    historyScopeId: "turn-west",
    metadata: withCoreAgentTurnMetadata(
      withAgentAskMetadata({}, ask("alpha")),
      {
        schema: "copilotz.core.agent-turn.v1",
        id: "turn-west",
        ownerParticipantId: "west",
        ...(history ? { history } : {}),
      },
    ),
  };
}

for (const history of [undefined, "scope"] as const) {
  Deno.test(`bounded internal initial Ask preserves its exact scope (${history ?? "mixed"})`, async () => {
    const alpha = internalQuestion(history);
    const beta = {
      ...message("beta", 2),
      visibility: { kind: "internal" },
      historyScopeId: "turn-west",
    };
    const latest = {
      ...message("latest", 3),
      visibility: { kind: "internal" },
      historyScopeId: "turn-west",
    };
    const f = fixture([alpha, beta, latest], { after: "beta" });
    await f.route(alpha);
    assertEquals(textValues(f.prepared[0].input.request.messages), [
      [values("latest-text"), values("latest-json")],
      [values("alpha-text"), values("alpha-json")],
    ]);
    const points = f.queries.filter(({ query }) => query.where?.id);
    assertEquals(points.length, 1);
    assert(points[0].inSnapshot);
    const query = points[0].query;
    assert(matchesCollectionFilter(query, alpha));
    assert(
      !matchesCollectionFilter(query, {
        ...alpha,
        historyScopeId: "other-turn",
      }),
    );
    assert(
      !matchesCollectionFilter(query, {
        ...alpha,
        visibility: { kind: "public" },
      }),
    );
    assert(
      !matchesCollectionFilter(query, { ...alpha, threadId: "other-thread" }),
    );
    // Private Agent turns do not notify ordinary conversation memory.
    assertEquals(f.histories, []);
  });
}

Deno.test("bounded internal initial Ask cannot revive another scope or inactive branch", async () => {
  const alpha = internalQuestion("scope");
  const beta = {
    ...message("beta", 3),
    visibility: { kind: "internal" },
    historyScopeId: "turn-west",
  };
  const latest = {
    ...message("latest", 4),
    visibility: { kind: "internal" },
    historyScopeId: "turn-west",
  };
  const root = message("branch-root", 0);
  for (const invalid of ["scope", "visibility", "branch"] as const) {
    const f = fixture([root, alpha, beta, latest], {
      after: "beta",
      ...(invalid === "branch"
        ? { branch: { rootMessageId: root.id, headMessageId: beta.id } }
        : {}),
      mutate(records) {
        if (invalid === "scope") {
          records.set("alpha", { ...alpha, historyScopeId: "other-turn" });
        }
        if (invalid === "visibility") {
          records.set("alpha", { ...alpha, visibility: { kind: "public" } });
        }
      },
    });
    await f.route(alpha);
    assertEquals(f.prepared, []);
  }
});
