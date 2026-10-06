import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  buildMemoryConsolidationInstruction,
  parseConsolidateMemoryInput,
  renderLongTermMemory,
  selectLongTermMemoryRange,
  stableMemoryRecordId,
} from "./index.ts";
import { CORE_MEMORY_KINDS, memorySourceKey } from "../ontology/index.ts";

Deno.test("maintenance instruction requires continuity even when no durable record changes", () => {
  const instruction = buildMemoryConsolidationInstruction({
    spaces: [{
      id: "shared",
      name: "Shared",
      scopeType: "thread",
      access: "read_write",
      defaultWrite: true,
    }],
    sourceMessages: [],
    kinds: [],
    context: [],
  });
  assertStringIncludes(
    instruction,
    "Every payload, including outcome no_changes",
  );
  assertStringIncludes(instruction, "will no longer be directly present");
  assertEquals(instruction.includes("no_changes alone"), false);
});

function options() {
  return {
    kinds: new Map(CORE_MEMORY_KINDS.map((kind) => [kind.id, kind])),
    writableMemorySpaceIds: new Set(["space-a"]),
    defaultWriteMemorySpaceId: "space-a",
    allowedEvidenceSources: new Set([
      memorySourceKey({ type: "message", id: "message-a" }),
      memorySourceKey({
        type: "collection_record",
        collection: "sharedDocument",
        id: "doc-a",
        version: 7,
      }),
    ]),
    visibleMemoryIds: new Set(["memory-old"]),
    visibleNodeIds: new Set(["sharedDocument:doc-a"]),
  };
}

Deno.test("consolidation validates forms, kinds, provenance, references, and temporal meaning", () => {
  const parsed = parseConsolidateMemoryInput({
    outcome: "changes",
    continuity: "Continue the migration and preserve provenance.",
    entities: [{
      localId: "project",
      kind: "entity.project",
      summary: "Compass is the active client project.",
      name: "Compass",
      aliases: ["Compass"],
      attributes: { portfolio: "clients" },
      sources: [{ type: "message", id: "message-a" }],
    }],
    assertions: [{
      localId: "state",
      kind: "assertion.state",
      summary: "Compass is migrating its memory architecture.",
      sources: [{
        type: "collection_record",
        collection: "sharedDocument",
        id: "doc-a",
        version: 7,
      }],
      subject: { localId: "project" },
      predicate: "migration_status",
      object: { value: "in_progress" },
      epistemic: { basis: "observed", stance: "affirmed" },
      temporal: { validFrom: "2026-08-14T00:00:00Z" },
    }],
    relations: [{
      from: { localId: "state" },
      type: "about",
      to: { localId: "project" },
    }],
    lifecycle: [{
      target: { memoryId: "memory-old" },
      status: "superseded",
      replacement: { localId: "state" },
      sources: [{ type: "message", id: "message-a" }],
    }],
  }, options());

  assertEquals(parsed.outcome, "changes");
  assertEquals(parsed.entities?.[0].spaceId, "space-a");
  assertEquals(parsed.entities?.[0].attributes, { portfolio: "clients" });
  assertEquals(parsed.assertions?.[0].epistemic, {
    basis: "observed",
    stance: "affirmed",
  });
  assertEquals(parsed.lifecycle?.[0].status, "superseded");
});

Deno.test("no_changes is explicit and cannot conceal mutations", () => {
  assertEquals(
    parseConsolidateMemoryInput({
      outcome: "no_changes",
      continuity: "No outstanding work.",
    }, options()),
    {
      outcome: "no_changes",
      continuity: "No outstanding work.",
    },
  );
  assertThrows(
    () =>
      parseConsolidateMemoryInput({
        outcome: "no_changes",
        continuity: "No outstanding work.",
        entities: [{
          localId: "hidden",
          kind: "entity.project",
          summary: "Hidden change",
          name: "Hidden",
          sources: [{ type: "message", id: "message-a" }],
        }],
      }, options()),
    TypeError,
    "cannot contain changes",
  );
  assertThrows(
    () =>
      parseConsolidateMemoryInput({
        outcome: "changes",
        continuity: "Continue.",
      }, options()),
    TypeError,
    "at least one change",
  );
});

Deno.test("omitted record sources inherit the bounded trusted catalogue", () => {
  const parsed = parseConsolidateMemoryInput({
    outcome: "changes",
    continuity: "Keep the active project context.",
    entities: [{
      localId: "project",
      kind: "entity.project",
      summary: "Compass is the active project.",
      name: "Compass",
    }],
  }, {
    ...options(),
    defaultEvidenceSources: [{ type: "message", id: "message-a" }],
  });
  assertEquals(parsed.entities?.[0].sources, [
    { type: "message", id: "message-a" },
  ]);
});

Deno.test("unauthorized, stale, and context-only sources are rejected", () => {
  const entity = (sources: unknown[]) => ({
    outcome: "changes",
    continuity: "Keep the active project context.",
    entities: [{
      localId: "project",
      kind: "entity.project",
      summary: "Compass project",
      name: "Compass",
      sources,
    }],
  });
  assertThrows(
    () =>
      parseConsolidateMemoryInput(
        entity([{ type: "message", id: "message-other" }]),
        options(),
      ),
    TypeError,
    "unauthorized",
  );
  assertThrows(
    () =>
      parseConsolidateMemoryInput(
        entity([{
          type: "collection_record",
          collection: "sharedDocument",
          id: "doc-a",
          version: 8,
        }]),
        options(),
      ),
    TypeError,
    "unauthorized",
  );
  assertThrows(
    () =>
      parseConsolidateMemoryInput(
        entity([{ type: "external", id: "context-only" }]),
        options(),
      ),
    TypeError,
    "unauthorized",
  );
  assertThrows(
    () =>
      parseConsolidateMemoryInput({
        ...entity([{ type: "message", id: "message-a" }]),
        entities: [{
          ...entity([{ type: "message", id: "message-a" }]).entities[0],
          spaceId: "space-read-only",
        }],
      }, options()),
    TypeError,
    "not writable",
  );
});

Deno.test("duplicate local IDs and invisible references are rejected before mutation", () => {
  assertThrows(
    () =>
      parseConsolidateMemoryInput({
        outcome: "changes",
        continuity: "Resolve duplicate records.",
        entities: ["a", "b"].map((name) => ({
          localId: "duplicate",
          kind: "entity.project",
          summary: name,
          name,
          sources: [{ type: "message", id: "message-a" }],
        })),
      }, options()),
    TypeError,
    "unique",
  );
  assertThrows(
    () =>
      parseConsolidateMemoryInput({
        outcome: "changes",
        continuity: "Resolve the target state.",
        assertions: [{
          localId: "assertion",
          kind: "assertion.state",
          summary: "Invisible target",
          sources: [{ type: "message", id: "message-a" }],
          subject: { memoryId: "not-visible" },
          predicate: "state",
          object: { value: "unknown" },
          epistemic: { basis: "reported", stance: "tentative" },
        }],
      }, options()),
    TypeError,
    "not visible",
  );
});

Deno.test("shared validation preserves all semantic forms and normalizes only declared fields", () => {
  const parsed = parseConsolidateMemoryInput({
    outcome: "changes",
    continuity: " Continue. ",
    entities: [{
      localId: " entity ",
      kind: "entity.project",
      summary: " Project ",
      name: " Compass ",
      externalIds: { " key ": " value " },
      attributes: { literal: " untouched " },
    }],
    assertions: [{
      localId: "assertion",
      kind: "assertion.state",
      summary: "State",
      subject: { localId: " entity " },
      predicate: " status ",
      object: { ref: { memoryId: "memory-old" } },
      epistemic: { basis: "reported", stance: "tentative" },
      temporal: { validFrom: " now " },
    }],
    occurrences: [{
      localId: "occurrence",
      kind: "occurrence.event",
      summary: "Event",
      participants: [{ node: { type: "sharedDocument", id: "doc-a" } }],
      temporal: { startedAt: " yesterday " },
    }],
    intents: [{
      localId: "intent",
      kind: "intent.objective",
      summary: "Objective",
      status: "active",
      owner: { localId: "entity" },
      target: { memoryId: "memory-old" },
      dueAt: " tomorrow ",
    }],
    inquiries: [{
      localId: "inquiry",
      kind: "inquiry.question",
      summary: "Question",
      question: " Why? ",
      status: "open",
      about: [{ localId: "entity" }],
    }],
    procedures: [{
      localId: "procedure",
      kind: "procedure.workflow",
      summary: "Steps",
      steps: [" First ", " Second "],
      preconditions: [" Ready "],
      trigger: " Start ",
    }],
  }, {
    ...options(),
    defaultEvidenceSources: [{ type: "message", id: "message-a" }],
  });
  assertEquals(parsed.continuity, "Continue.");
  assertEquals(parsed.entities?.[0].name, "Compass");
  assertEquals(parsed.entities?.[0].attributes, { literal: " untouched " });
  assertEquals(parsed.entities?.[0].externalIds, { key: "value" });
  assertEquals(parsed.assertions?.[0].subject, { localId: "entity" });
  assertEquals(parsed.assertions?.[0].object, {
    ref: { memoryId: "memory-old" },
  });
  assertEquals(parsed.occurrences?.[0].temporal, { startedAt: "yesterday" });
  assertEquals(parsed.intents?.[0].dueAt, "tomorrow");
  assertEquals(parsed.inquiries?.[0].question, "Why?");
  assertEquals(parsed.procedures?.[0].steps, ["First", "Second"]);
});

Deno.test("direct callers cannot bypass the detailed structural schema", () => {
  const entity = {
    localId: "entity",
    kind: "entity.project",
    summary: "Project",
    name: "Compass",
  };
  for (
    const patch of [{ name: 42 }, { kind: "unregistered" }, {
      arbitraryAuthority: "admin",
    }, { attributes: [] }]
  ) {
    assertThrows(
      () =>
        parseConsolidateMemoryInput({
          outcome: "changes",
          continuity: "Continue",
          entities: [{ ...entity, ...patch }],
        }, options()),
      TypeError,
    );
  }
});

Deno.test("range reservation keeps a chronological prefix and recent tail", () => {
  const selected = selectLongTermMemoryRange({
    messages: [
      { id: "m0", senderType: "agent", senderId: "a", text: "boundary" },
      { id: "m1", senderType: "human", senderId: "u", text: "one two three" },
      { id: "m2", senderType: "agent", senderId: "a", text: "four five six" },
      { id: "m3", senderType: "tool", senderId: "t", text: "seven eight" },
      { id: "m4", senderType: "human", senderId: "u", text: "nine ten" },
    ],
    triggerMessageId: "m4",
    previousBoundaryMessageId: "m0",
    triggerEstimatedTokens: 1,
    retainRecentEstimatedTokens: 1,
  });
  assertEquals(selected?.sourceStartMessageId, "m1");
  assertEquals(selected?.sourceEndMessageId, "m3");
});

Deno.test("a retained tool result does not retain its earlier call", () => {
  const selected = selectLongTermMemoryRange({
    messages: [
      { id: "question", senderType: "human", senderId: "u", text: "question" },
      {
        id: "call",
        senderType: "assistant",
        senderId: "north",
        text: "ask south",
        toolCalls: [{ id: "ask", action: "ask" }],
      },
      { id: "result", senderType: "tool", senderId: "ask", text: "answer" },
    ],
    triggerMessageId: "result",
    triggerEstimatedTokens: 1,
    retainRecentEstimatedTokens: 1,
  });
  assertEquals(selected?.sourceEndMessageId, "call");
  assertEquals(selected?.retainedMessageCount, 1);
});

Deno.test("a large retained message does not falsely report a full source budget", () => {
  const messages = [
    {
      id: "source",
      senderType: "human",
      senderId: "u",
      text: "s ".repeat(100_000),
    },
    {
      id: "large-tail",
      senderType: "human",
      senderId: "u",
      text: "t ".repeat(18_000),
    },
    { id: "small-tail", senderType: "human", senderId: "u", text: "small" },
  ] as const;
  const selected = selectLongTermMemoryRange({
    messages,
    triggerMessageId: "small-tail",
    triggerEstimatedTokens: 0,
    retainRecentEstimatedTokens: 8_000,
    maxSourceEstimatedTokens: 60_000,
  });
  assertEquals(selected?.sourceEndMessageId, "source");
  assertEquals(selected?.sourceLimitReached, false);
});

Deno.test("an open Ask can be summarized without waiting for its answer", () => {
  const selected = selectLongTermMemoryRange({
    messages: [
      {
        id: "call",
        senderType: "assistant",
        senderId: "north",
        text: "ask south",
        toolCalls: [{ id: "ask", action: "ask" }],
      },
      {
        id: "progress",
        senderType: "user",
        senderId: "south",
        text: "still working",
      },
    ],
    triggerMessageId: "progress",
    triggerEstimatedTokens: 1,
    retainRecentEstimatedTokens: 1,
  });
  assertEquals(selected?.sourceEndMessageId, "call");
});

Deno.test("range reservation is a safe no-op when its prior boundary is absent", () => {
  const selected = selectLongTermMemoryRange({
    messages: [
      { id: "m1", senderType: "human", senderId: "u", text: "one" },
      { id: "m2", senderType: "agent", senderId: "a", text: "two" },
    ],
    triggerMessageId: "m2",
    previousBoundaryMessageId: "missing-boundary",
    triggerEstimatedTokens: 1,
  });

  assertEquals(selected, null);
});

Deno.test("first checkpoint reserves the contiguous eligible prefix", () => {
  const selected = selectLongTermMemoryRange({
    messages: Array.from({ length: 10 }, (_, index) => ({
      id: `m${index}`,
      senderType: "human" as const,
      senderId: "u",
      text: "x",
    })),
    triggerMessageId: "m9",
    triggerEstimatedTokens: 1,
  });

  assertEquals(selected?.sourceStartMessageId, "m0");
  assertEquals(selected?.sourceEndMessageId, "m9");
});

Deno.test("derived continuity is rendered from ordinary records", () => {
  const text = renderLongTermMemory({
    records: [{
      id: "objective",
      memorySpaceId: "space-a",
      form: "intent",
      kind: "intent.objective",
      summary: "Ship the event-native memory refactor.",
      status: "active",
      validity: "valid",
      data: {},
    }, {
      id: "question",
      memorySpaceId: "space-a",
      form: "inquiry",
      kind: "inquiry.question",
      summary: "Will the migration preserve provenance?",
      status: "open",
      validity: "valid",
      data: {},
    }],
    relations: [{ sourceId: "question", type: "about", targetId: "objective" }],
    maxContentEstimatedTokens: 2_000,
  });
  assertStringIncludes(text, "### Objectives and purpose");
  assertStringIncludes(text, "Ship the event-native memory refactor");
  assertStringIncludes(text, "### Open inquiries");
  assertStringIncludes(text, "--about-->");
  assertEquals(
    stableMemoryRecordId("checkpoint", "a/b"),
    "checkpoint:record:a%2Fb",
  );
});

Deno.test("maintenance instruction names the only valid action and registered taxonomy", () => {
  const instruction = buildMemoryConsolidationInstruction({
    spaces: [{
      id: "space-a",
      name: "A",
      scopeType: "thread",
      access: "read_write",
      defaultWrite: true,
    }],
    sourceMessages: [{
      id: "message-a",
      senderType: "human",
      senderId: "user",
      text: "remember this",
      toolCalls: [{ name: "lookup", arguments: { id: "a" } }],
      reasoning: "This is durable.",
    }],
    kinds: CORE_MEMORY_KINDS,
    context: [],
  });
  assertStringIncludes(instruction, "Call consolidate_memory exactly once");
  assertStringIncludes(instruction, "no_changes");
  assertStringIncludes(instruction, "assertion.state");
  assertStringIncludes(instruction, "message-a");
  assertEquals(instruction.includes("remember this"), false);
  assertEquals(instruction.includes("This is durable."), false);
  assertEquals(instruction.includes('"toolCalls"'), false);
  assertStringIncludes(instruction, "complete reserved source range");
});
