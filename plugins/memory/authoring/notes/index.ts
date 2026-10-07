/** Immutable notes and deterministic memory preparation. @module */
import type { ActionSchema } from "@copilotz/copilotz/actions";
import type { ContextSourceRef } from "@copilotz/copilotz/core";
import { estimateTextTokens } from "@copilotz/copilotz/llm/tokens";
import { Ajv } from "../../../../dependencies/ajv.ts";

export type MemoryProposal = Readonly<{
  continuity: string;
  remember?: readonly Readonly<
    { text: string; replaces?: readonly string[]; sources?: readonly string[] }
  >[];
  retire?: readonly Readonly<{ id: string; reason: string }>[];
}>;

export const memoryProposalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["continuity"],
  properties: {
    continuity: {
      type: "string",
      minLength: 1,
      description:
        "Replacement continuity for the entire compacted history: current work, decisions, constraints, results and unresolved questions.",
    },
    remember: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: {
            type: "string",
            minLength: 1,
            description:
              "One durable note. Keep authorship, dates, negation and uncertainty explicit; procedures may be multiline.",
          },
          replaces: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
            description:
              "Active note IDs in the writable scope replaced by this note.",
          },
          sources: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
            description:
              "Optional exact source handles from the supplied evidence catalog. Never invent a handle.",
          },
        },
      },
    },
    retire: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "reason"],
        properties: {
          id: { type: "string", minLength: 1 },
          reason: {
            type: "string",
            minLength: 1,
            description:
              "Why this note should leave active memory. Completion usually deserves a replacement note.",
          },
        },
      },
    },
  },
} as const satisfies ActionSchema;

// Ajv's portable CJS dependency exposes an untyped constructor.
// deno-lint-ignore no-explicit-any
const proposalValidator = new (Ajv as any)({ strict: false, allErrors: true });
const validateProposal = proposalValidator.compile(memoryProposalSchema);

export type MemoryNote = Readonly<{
  id: string;
  memorySpaceId: string;
  text: string;
  createdAt: string;
  sources: readonly ContextSourceRef[];
  retirement?: Readonly<
    {
      checkpointId: string;
      retiredAt: string;
      retiredBy: string;
      reason: string;
      replacedBy?: string;
    }
  >;
}>;

export class MemoryProposalConflict extends Error {
  readonly currentIds: readonly string[];
  constructor(message: string, currentIds: readonly string[] = []) {
    const bounded = currentIds.slice(0, 20).map((id) => id.slice(0, 200));
    super(
      `${message.slice(0, 1000)}${
        bounded.length
          ? ` Related note IDs: ${JSON.stringify(bounded)}${
            currentIds.length > bounded.length ? " (truncated)" : ""
          }.`
          : ""
      }`,
    );
    this.currentIds = bounded;
    this.name = "MemoryProposalConflict";
  }
}

export type PreparedMemoryProposal = Readonly<{
  continuity: string;
  notes: readonly Readonly<
    {
      id: string;
      text: string;
      reused: boolean;
      replaces: readonly string[];
      sources: readonly ContextSourceRef[];
    }
  >[];
  retire: readonly Readonly<{ id: string; reason: string }>[];
}>;

/** Text is never trimmed or normalized; whitespace can carry meaning. */
export function prepareMemoryProposal(
  raw: unknown,
  input: Readonly<{
    checkpointId: string;
    writeScopeId: string;
    notes: readonly MemoryNote[];
    sources: ReadonlyMap<string, ContextSourceRef>;
  }>,
): PreparedMemoryProposal {
  if (!validateProposal(raw)) {
    throw new MemoryProposalConflict(
      `Memory proposal failed schema validation: ${
        proposalValidator.errorsText(validateProposal.errors)
      }`,
    );
  }
  const proposal = raw as MemoryProposal;
  if (!proposal.continuity.trim()) {
    throw new MemoryProposalConflict("Continuity must contain text.");
  }
  const writable = new Map(
    input.notes.filter((note) =>
      note.memorySpaceId === input.writeScopeId && !note.retirement
    ).map((note) => [note.id, note]),
  );
  const activeText = new Map(
    [...writable.values()].map((note) => [note.text, note]),
  );
  const targets = new Set<string>();
  const target = (id: string) => {
    if (!writable.has(id)) {
      throw new MemoryProposalConflict(
        `Note '${id}' is not active in the writable scope.`,
        [...writable.keys()],
      );
    }
    if (targets.has(id)) {
      throw new MemoryProposalConflict(
        `Note '${id}' appears in more than one retirement or replacement.`,
        [id],
      );
    }
    targets.add(id);
  };
  const drafts = new Map<
    string,
    { text: string; replaces: readonly string[]; sources: Set<string> }
  >();
  for (const note of proposal.remember ?? []) {
    if (!note.text.trim()) {
      throw new MemoryProposalConflict("A note must contain text.");
    }
    const replaces = [...(note.replaces ?? [])].sort();
    const existing = drafts.get(note.text);
    if (
      existing && JSON.stringify(existing.replaces) !== JSON.stringify(replaces)
    ) {
      throw new MemoryProposalConflict(
        "Identical notes have conflicting replacement targets.",
      );
    }
    const sources = existing?.sources ?? new Set<string>();
    for (const handle of note.sources ?? []) {
      if (!input.sources.has(handle)) {
        throw new MemoryProposalConflict(
          `Unknown source handle '${handle}'. Use a supplied handle or omit sources.`,
        );
      }
      sources.add(handle);
    }
    drafts.set(note.text, { text: note.text, replaces, sources });
  }
  for (const note of drafts.values()) note.replaces.forEach(target);
  for (const retirement of proposal.retire ?? []) {
    if (!retirement.reason.trim()) {
      throw new MemoryProposalConflict("Retirement requires a reason.");
    }
    target(retirement.id);
  }
  // Sorting makes corrected/reordered proposals deterministic. Only the atomic
  // checkpoint commit may choose a winner; failed proposals reserve no IDs.
  const notes = [...drafts.values()].sort((a, b) => compare(a.text, b.text))
    .map((draft, index) => {
      const existing = activeText.get(draft.text);
      if (existing && targets.has(existing.id)) {
        throw new MemoryProposalConflict(
          `Exact-content reuse would retire note '${existing.id}'.`,
          [existing.id],
        );
      }
      return {
        id: existing?.id ?? `${input.checkpointId}:note:${index + 1}`,
        text: draft.text,
        reused: !!existing,
        replaces: draft.replaces,
        sources: [...draft.sources].sort().map((handle) =>
          structuredClone(input.sources.get(handle)!)
        ),
      };
    });
  return {
    continuity: proposal.continuity,
    notes,
    retire: structuredClone(proposal.retire ?? []),
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const OMITTED_NOTES_NOTICE =
  "Additional notes omitted; use search_memory to retrieve them.";
export const memoryContinuityText = (continuity?: string): string =>
  continuity ? `Conversation continuity:\n${continuity}` : "";

/** Reserve the same framing used in subsequent ordinary turns before committing. */
export function assertMemoryContinuityFits(
  continuity: string,
  maxEstimatedTokens: number,
): void {
  if (
    estimateTextTokens(
      `${memoryContinuityText(continuity)}\n\n${OMITTED_NOTES_NOTICE}`,
    ) > maxEstimatedTokens
  ) {
    throw new MemoryProposalConflict(
      "Continuity leaves no room for the memory framing. Compress it to fit the configured memory allowance before committing.",
    );
  }
}

/** Select recent notes, then render chronologically for a stable prefix. */
export function renderMemoryNotes(
  input: Readonly<{
    continuity?: string;
    notes: readonly MemoryNote[];
    writableScopeIds: ReadonlySet<string>;
    readableScopeIds: ReadonlySet<string>;
    maxEstimatedTokens: number;
    candidatesTruncated?: boolean;
  }>,
): Readonly<{ text: string; ids: readonly string[]; omitted: number }> {
  const base = memoryContinuityText(input.continuity);
  const notes = [
    ...new Map(
      input.notes.filter((note) =>
        !note.retirement && input.readableScopeIds.has(note.memorySpaceId)
      ).map((note) => [note.id, note]),
    ).values(),
  ];
  notes.sort((a, b) =>
    Number(!input.writableScopeIds.has(a.memorySpaceId)) -
      Number(!input.writableScopeIds.has(b.memorySpaceId)) ||
    compare(b.createdAt, a.createdAt) || compare(b.id, a.id)
  );
  const selected: MemoryNote[] = [];
  const render = (chosen: readonly MemoryNote[]) => {
    const sections = [base];
    for (const own of [true, false]) {
      const group = chosen.filter((note) =>
        input.writableScopeIds.has(note.memorySpaceId) === own
      ).sort((a, b) =>
        compare(a.createdAt, b.createdAt) || compare(a.id, b.id)
      );
      if (group.length) {
        sections.push(
          `${own ? "Your notes" : "Peer notes (read only)"}:\n${
            group.map((note) => `[${note.id}] ${note.text}`).join("\n")
          }`,
        );
      }
    }
    const omitted = notes.length - chosen.length;
    if (omitted || input.candidatesTruncated) {
      sections.push(OMITTED_NOTES_NOTICE);
    }
    return sections.filter(Boolean).join("\n\n");
  };
  for (const note of notes) {
    if (
      estimateTextTokens(render([...selected, note])) <=
        input.maxEstimatedTokens
    ) selected.push(note);
  }
  const text = render(selected);
  // A reduced configuration must not strand a saved checkpoint or discard its
  // covered history. Preserve continuity; the new allowance governs added notes
  // and future checkpoint commits. Core still enforces the model input budget.
  return {
    text,
    ids: selected.map((note) => note.id),
    omitted: notes.length - selected.length,
  };
}
