import { assert, assertEquals, assertThrows } from "@std/assert";
import { estimateTextTokens } from "@copilotz/copilotz/llm/tokens";
import { generateAgentTypesFromSchema } from "../../../llm/shared/schema-to-agent-types.ts";
import {
  assertMemoryContinuityFits,
  type MemoryNote,
  MemoryProposalConflict,
  memoryProposalSchema,
  prepareMemoryProposal,
  renderMemoryNotes,
} from "./index.ts";

const note = (id: string, text: string, memorySpaceId = "own"): MemoryNote => ({
  id,
  text,
  memorySpaceId,
  createdAt: "2026-10-01T12:00:00Z",
  sources: [],
});
const context = (notes: MemoryNote[] = []) => ({
  checkpointId: "checkpoint",
  writeScopeId: "own",
  notes,
  sources: new Map([["message:m1", { type: "message" as const, id: "m1" }], [
    "message:m2",
    { type: "message" as const, id: "m2" },
  ]]),
});

Deno.test("memory proposals preserve negation, uncertainty and procedure whitespace", () => {
  const text =
    "Client does NOT use Stripe (Ana, 2026-10-01; unverified).\nProcedure:\n  1. Check logs.\n  2. Ask Ana.";
  const result = prepareMemoryProposal({
    continuity: "Current work remains unverified.",
    remember: [{ text, sources: ["message:m1"] }],
  }, context());
  assertEquals(result.notes[0].text, text);
  assertEquals(result.notes[0].sources, [{ type: "message", id: "m1" }]);
  assertEquals(
    prepareMemoryProposal({ continuity: "No change." }, context()).notes,
    [],
  );
});

Deno.test("exact note reuse is scoped to active notes and never normalizes text", () => {
  const retired: MemoryNote = {
    ...note("retired", "Was wrong."),
    retirement: {
      checkpointId: "old",
      retiredAt: "2026-10-01",
      retiredBy: "agent",
      reason: "Incorrect.",
    },
  };
  const result = prepareMemoryProposal(
    {
      continuity: "Continue.",
      remember: [
        { text: "Same." },
        { text: "Same. " },
        { text: "Was wrong." },
        { text: "Peer only." },
      ],
    },
    context([
      note("active", "Same."),
      retired,
      note("peer", "Peer only.", "peer"),
    ]),
  );
  assertEquals(
    result.notes.find((item) => item.text === "Same.")?.id,
    "active",
  );
  assertEquals(result.notes.filter((item) => item.reused).length, 1);
  assertEquals(
    result.notes.some((item) => item.id === "retired" || item.id === "peer"),
    false,
  );
});

Deno.test("identical proposal notes coalesce sources and preserve deterministic identities", () => {
  const remember = [{ text: "B", sources: ["message:m1"] }, { text: "A" }, {
    text: "B",
    sources: ["message:m2"],
  }];
  const first = prepareMemoryProposal(
    { continuity: "Continue.", remember },
    context(),
  );
  const second = prepareMemoryProposal({
    continuity: "Continue.",
    remember: [...remember].reverse(),
  }, context());
  assertEquals(first, second);
  assertEquals(first.notes.length, 2);
  assertEquals(first.notes[1].sources.length, 2);
});

Deno.test("retirement conflicts, read-only targets and invented sources require repair", () => {
  const cases = [
    { remember: [{ text: "New", replaces: ["peer"] }] },
    { remember: [{ text: "Old", replaces: ["old"] }] },
    { remember: [{ text: "New", sources: ["message:invented"] }] },
    {
      remember: [{ text: "New", replaces: ["old"] }],
      retire: [{ id: "old", reason: "Wrong" }],
    },
    { remember: [{ text: "New", replaces: ["old"] }, { text: "New" }] },
    {
      retire: [{ id: "old", reason: "Wrong" }, {
        id: "old",
        reason: "Also wrong",
      }],
    },
  ];
  for (const proposal of cases) {
    assertThrows(() =>
      prepareMemoryProposal(
        { continuity: "Continue.", ...proposal },
        context([note("old", "Old"), note("peer", "Peer", "peer")]),
      ), MemoryProposalConflict);
  }
});

Deno.test("unified rendering reserves continuity, filters current grants, and omits whole notes", () => {
  const notes = [
    note("large", "Unabridged procedure. ".repeat(500)),
    note("small", "Keep the negation: no Stripe."),
    note("peer", "Shared fact.", "peer"),
    note("revoked", "Hidden.", "revoked"),
  ];
  const args = {
    continuity: "Continue the current investigation.",
    notes,
    readableScopeIds: new Set(["own", "peer"]),
    writableScopeIds: new Set(["own"]),
    maxEstimatedTokens: 150,
  };
  const rendered = renderMemoryNotes(args);
  assert(
    rendered.text.startsWith(
      "Conversation continuity:\nContinue the current investigation.",
    ),
  );
  assertEquals(rendered.ids, ["small", "peer"]);
  assertEquals(rendered.omitted, 1);
  assertEquals(rendered.text.includes("Unabridged"), false);
  assertEquals(rendered.text.includes("Hidden"), false);
  assert(estimateTextTokens(rendered.text) <= 150);
  assertEquals(
    renderMemoryNotes({ ...args, notes: [...notes].reverse() }),
    rendered,
  );
  const oversized = renderMemoryNotes({
    ...args,
    continuity: "Long. ".repeat(200),
  });
  assert(
    oversized.text.startsWith(
      "Conversation continuity:\n" + "Long. ".repeat(200),
    ),
  );
  assertEquals(oversized.ids, []);
  assertEquals(oversized.omitted, 3);
});

Deno.test("note schema stays below the approved 1500-token and 15-declaration limits", () => {
  const rendered = generateAgentTypesFromSchema(memoryProposalSchema as never, {
    rootName: "ConsolidateMemoryInput",
  });
  const tokens = estimateTextTokens(rendered);
  const declarations =
    [...rendered.matchAll(/export (?:interface|type) /g)].length;
  assert(tokens <= 1500);
  assert(declarations <= 15);
  assert(tokens < 11552 * 0.2);
  console.log(
    JSON.stringify({
      schemaEstimatedTokens: tokens,
      declarations,
      baselineEstimatedTokens: 11552,
    }),
  );
});

Deno.test("recent corrections win selection while the rendered selection stays chronological", () => {
  const notes = Array.from(
    { length: 40 },
    (_, i) => ({
      ...note(`note-${i}`, `Decision ${i}: ${"detail ".repeat(20)}`),
      createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    }),
  );
  const input = {
    continuity: "Decision 39 is current; earlier decisions were superseded.",
    notes,
    readableScopeIds: new Set(["own"]),
    writableScopeIds: new Set(["own"]),
    maxEstimatedTokens: 160,
  };
  const result = renderMemoryNotes(input);
  assert(result.ids.includes("note-39"));
  assert(!result.ids.includes("note-0"));
  assertEquals(
    renderMemoryNotes({ ...input, notes: [...notes].reverse() }),
    result,
  );
  const displayed = [...result.text.matchAll(/\[note-(\d+)\]/g)].map((match) =>
    Number(match[1])
  );
  assertEquals(displayed, [...displayed].sort((a, b) => a - b));
});

Deno.test("continuity validation reserves the later prompt framing before commit", () => {
  const continuity = "Keep this full continuity.";
  assertThrows(
    () =>
      assertMemoryContinuityFits(
        continuity,
        estimateTextTokens(continuity) + 3,
      ),
    MemoryProposalConflict,
  );
  assertMemoryContinuityFits(continuity, 100);
  const rendered = renderMemoryNotes({
    continuity,
    notes: [note("large", "long ".repeat(300))],
    writableScopeIds: new Set(["own"]),
    readableScopeIds: new Set(["own"]),
    maxEstimatedTokens: 100,
  });
  assertEquals(rendered.omitted, 1);
  assert(rendered.text.includes(continuity));
});
