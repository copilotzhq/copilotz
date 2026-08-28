import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  buildMemoryConsolidationInstruction,
  parseConsolidateMemoryInput,
  renderLongTermMemory,
  selectLongTermMemoryRange,
  stableMemoryRecordId,
} from "./index.ts";
import { CORE_MEMORY_KINDS, memorySourceKey } from "../ontology/index.ts";

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
    parseConsolidateMemoryInput({ outcome: "no_changes" }, options()),
    {
      outcome: "no_changes",
    },
  );
  assertThrows(
    () =>
      parseConsolidateMemoryInput({
        outcome: "no_changes",
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
    () => parseConsolidateMemoryInput({ outcome: "changes" }, options()),
    TypeError,
    "at least one change",
  );
});

Deno.test("omitted record sources inherit the bounded trusted catalogue", () => {
  const parsed = parseConsolidateMemoryInput({
    outcome: "changes",
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

Deno.test("range reservation retains tool-result units and remains deterministic", () => {
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

Deno.test("derived continuity is rendered from ordinary records", () => {
  const text = renderLongTermMemory({
    records: [{
      id: "objective",
      memorySpaceId: "space-a",
      form: "intent",
      kind: "intent.objective",
      summary: "Ship the event-native memory refactor.",
      status: "active",
      data: {},
    }, {
      id: "question",
      memorySpaceId: "space-a",
      form: "inquiry",
      kind: "inquiry.question",
      summary: "Will the migration preserve provenance?",
      status: "open",
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
    }],
    kinds: CORE_MEMORY_KINDS,
    previousRecords: [],
    context: [],
  });
  assertStringIncludes(instruction, "Call consolidate_memory exactly once");
  assertStringIncludes(instruction, "no_changes");
  assertStringIncludes(instruction, "assertion.state");
});
