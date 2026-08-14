import type { ContentRef } from "../content/index.ts";

export const MEMORY_FORMS: readonly [
  "entity",
  "assertion",
  "occurrence",
  "intent",
  "inquiry",
  "procedure",
] = Object.freeze(
  [
    "entity",
    "assertion",
    "occurrence",
    "intent",
    "inquiry",
    "procedure",
  ] as const,
);

export type MemoryForm = typeof MEMORY_FORMS[number];

export const MEMORY_RELATION_TYPES: readonly [
  "about",
  "derived_from",
  "same_as",
  "supports",
  "contradicts",
  "supersedes",
  "depends_on",
  "contributes_to",
  "blocks",
  "answers",
] = Object.freeze(
  [
    "about",
    "derived_from",
    "same_as",
    "supports",
    "contradicts",
    "supersedes",
    "depends_on",
    "contributes_to",
    "blocks",
    "answers",
  ] as const,
);

export type MemoryRelationType = typeof MEMORY_RELATION_TYPES[number];

export const MEMORY_LIFECYCLES: Readonly<{
  entity: readonly ["active", "merged", "archived"];
  assertion: readonly ["current", "superseded", "retracted", "disputed"];
  occurrence: readonly ["scheduled", "happened", "cancelled"];
  intent: readonly [
    "proposed",
    "active",
    "completed",
    "cancelled",
    "superseded",
  ];
  inquiry: readonly ["open", "answered", "obsolete"];
  procedure: readonly ["active", "deprecated"];
}> = Object.freeze({
  entity: Object.freeze(["active", "merged", "archived"] as const),
  assertion: Object.freeze(
    [
      "current",
      "superseded",
      "retracted",
      "disputed",
    ] as const,
  ),
  occurrence: Object.freeze(["scheduled", "happened", "cancelled"] as const),
  intent: Object.freeze(
    [
      "proposed",
      "active",
      "completed",
      "cancelled",
      "superseded",
    ] as const,
  ),
  inquiry: Object.freeze(["open", "answered", "obsolete"] as const),
  procedure: Object.freeze(["active", "deprecated"] as const),
});

export type MemoryLifecycleStatus =
  typeof MEMORY_LIFECYCLES[MemoryForm][number];

export type MemorySourceRef =
  | Readonly<{ type: "message"; id: string }>
  | Readonly<{ type: "tool_execution"; id: string }>
  | Readonly<{ type: "asset"; id: string }>
  | Readonly<{ type: "external"; id: string }>
  | Readonly<{
    type: "collection_record";
    collection: string;
    id: string;
    version?: string | number;
    updatedAt?: string;
    fragment?: string;
  }>;

export type MemoryNodeRef = Readonly<{ type: string; id: string }>;

export type ProposedMemoryRef =
  | Readonly<{ localId: string }>
  | Readonly<{ memoryId: string }>
  | Readonly<{ node: MemoryNodeRef }>;

export type MemoryTemporal = Readonly<{
  validFrom?: string;
  validTo?: string;
  recordedAt: string;
  invalidatedAt?: string;
}>;

export type MemoryEpistemic = Readonly<{
  basis: "observed" | "reported" | "inferred" | "assumed";
  stance: "affirmed" | "denied" | "tentative" | "disputed";
}>;

export type MemoryProvenance = Readonly<{
  sources: readonly MemorySourceRef[];
  assertedBy?: MemoryNodeRef;
  recordedBy: MemoryNodeRef;
  derivedFromMemoryIds?: readonly string[];
  consolidationId: string;
}>;

export type MemoryKindDefinition = Readonly<{
  id: string;
  form: MemoryForm;
  description: string;
  schema?: Readonly<Record<string, unknown>>;
}>;

export type MemoryRecord = Readonly<{
  id: string;
  memorySpaceId: string;
  consolidationId: string;
  originThreadId: string;
  createdByAgentId: string;
  form: MemoryForm;
  kind: string;
  summary: string;
  content?: readonly ContentRef[];
  status: MemoryLifecycleStatus;
  temporal: MemoryTemporal;
  epistemic?: MemoryEpistemic;
  provenance: MemoryProvenance;
  data: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type MemoryDraftBase = Readonly<{
  localId: string;
  kind: string;
  summary: string;
  spaceId?: string;
  sources: readonly MemorySourceRef[];
  /** Namespaced, kind-specific semantic fields validated by the kind schema. */
  attributes?: Readonly<Record<string, unknown>>;
}>;

export type EntityMemoryDraft =
  & MemoryDraftBase
  & Readonly<{
    name: string;
    aliases?: readonly string[];
    externalIds?: Readonly<Record<string, string>>;
  }>;

export type AssertionMemoryDraft =
  & MemoryDraftBase
  & Readonly<{
    subject: ProposedMemoryRef;
    predicate: string;
    object:
      | Readonly<{ ref: ProposedMemoryRef }>
      | Readonly<{ value: string | number | boolean | null }>;
    epistemic: MemoryEpistemic;
    temporal?: Readonly<{ validFrom?: string; validTo?: string }>;
  }>;

export type OccurrenceMemoryDraft =
  & MemoryDraftBase
  & Readonly<{
    participants?: readonly ProposedMemoryRef[];
    temporal?: Readonly<{ startedAt?: string; endedAt?: string }>;
  }>;

export type IntentMemoryDraft =
  & MemoryDraftBase
  & Readonly<{
    owner?: ProposedMemoryRef;
    status: "proposed" | "active" | "completed" | "cancelled";
    target?: ProposedMemoryRef;
    dueAt?: string;
  }>;

export type InquiryMemoryDraft =
  & MemoryDraftBase
  & Readonly<{
    question: string;
    status: "open" | "answered" | "obsolete";
    about?: readonly ProposedMemoryRef[];
    answer?: ProposedMemoryRef;
  }>;

export type ProcedureMemoryDraft =
  & MemoryDraftBase
  & Readonly<{
    trigger?: string;
    preconditions?: readonly string[];
    steps: readonly string[];
    expectedOutcome?: string;
    applicability?: string;
  }>;

export type MemoryRelationDraft = Readonly<{
  from: ProposedMemoryRef;
  type: Exclude<MemoryRelationType, "derived_from" | "supersedes">;
  to: ProposedMemoryRef;
  sources?: readonly MemorySourceRef[];
}>;

export type MemoryLifecycleDraft = Readonly<{
  target:
    | Readonly<{ memoryId: string }>
    | Readonly<{
      match: Readonly<{
        form: MemoryForm;
        kind?: string;
        subject?: ProposedMemoryRef;
        predicate?: string;
        query: string;
      }>;
    }>;
  status:
    | "superseded"
    | "retracted"
    | "completed"
    | "cancelled"
    | "answered"
    | "obsolete"
    | "deprecated";
  replacement?: ProposedMemoryRef;
  sources: readonly MemorySourceRef[];
}>;

export type ConsolidateMemoryInput = Readonly<{
  outcome: "changes" | "no_changes";
  entities?: readonly EntityMemoryDraft[];
  assertions?: readonly AssertionMemoryDraft[];
  occurrences?: readonly OccurrenceMemoryDraft[];
  intents?: readonly IntentMemoryDraft[];
  inquiries?: readonly InquiryMemoryDraft[];
  procedures?: readonly ProcedureMemoryDraft[];
  relations?: readonly MemoryRelationDraft[];
  lifecycle?: readonly MemoryLifecycleDraft[];
}>;

const CORE_KIND_INPUT = [
  ["entity.person", "entity", "A person or human identity."],
  ["entity.agent", "entity", "An agent or autonomous participant."],
  ["entity.organization", "entity", "An organization or team."],
  ["entity.project", "entity", "A project or bounded initiative."],
  ["entity.system", "entity", "A software or operational system."],
  ["entity.document", "entity", "A durable document or canonical artifact."],
  ["entity.product", "entity", "A product or service."],
  ["entity.concept", "entity", "A stable concept worth referring to."],
  ["entity.location", "entity", "A physical or virtual location."],
  ["assertion.identity", "assertion", "A stable identifying proposition."],
  ["assertion.state", "assertion", "A temporally valid state."],
  ["assertion.preference", "assertion", "An expressed preference."],
  ["assertion.constraint", "assertion", "A requirement or boundary."],
  ["assertion.criterion", "assertion", "A success or decision criterion."],
  ["assertion.risk", "assertion", "A risk or blocker."],
  ["assertion.capability", "assertion", "A capability or limitation."],
  ["assertion.relationship", "assertion", "A domain relationship proposition."],
  ["assertion.policy", "assertion", "A policy or governing rule."],
  ["assertion.observation", "assertion", "An observed durable condition."],
  ["assertion.lesson", "assertion", "A durable learned lesson."],
  ["occurrence.event", "occurrence", "A meaningful event that happened."],
  ["occurrence.change", "occurrence", "A meaningful state change."],
  ["occurrence.failure", "occurrence", "A meaningful failure."],
  ["occurrence.scheduled", "occurrence", "A scheduled occurrence."],
  ["intent.purpose", "intent", "A continuing purpose."],
  ["intent.objective", "intent", "A desired outcome."],
  ["intent.decision", "intent", "A decision currently in force."],
  ["intent.plan", "intent", "An active approach or plan."],
  ["intent.action", "intent", "A committed next action or task."],
  ["inquiry.question", "inquiry", "An unresolved question."],
  ["inquiry.unknown", "inquiry", "A material unknown."],
  [
    "inquiry.validation_needed",
    "inquiry",
    "A claim that still needs validation.",
  ],
  ["procedure.workflow", "procedure", "A reusable workflow."],
  ["procedure.playbook", "procedure", "A reusable playbook."],
  ["procedure.diagnostic", "procedure", "A reusable diagnostic procedure."],
  ["procedure.workaround", "procedure", "A reusable workaround."],
  ["procedure.tool_usage", "procedure", "A durable tool-usage pattern."],
  [
    "procedure.environment_gotcha",
    "procedure",
    "An environment-specific gotcha.",
  ],
] as const satisfies readonly (readonly [string, MemoryForm, string])[];

export const CORE_MEMORY_KINDS: readonly MemoryKindDefinition[] = Object.freeze(
  CORE_KIND_INPUT.map(([id, form, description]) =>
    Object.freeze({ id, form, description })
  ),
);

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

export function defineMemoryKind(
  input: MemoryKindDefinition,
): MemoryKindDefinition {
  const id = requiredText(input.id, "Memory kind id");
  if (!MEMORY_FORMS.includes(input.form)) {
    throw new TypeError(`Memory kind '${id}' has an invalid form.`);
  }
  return Object.freeze({
    id,
    form: input.form,
    description: requiredText(input.description, "Memory kind description"),
    ...(input.schema
      ? { schema: Object.freeze(structuredClone(input.schema)) }
      : {}),
  });
}

export function memoryLifecycleAllows(
  form: MemoryForm,
  status: string,
): status is MemoryLifecycleStatus {
  return (MEMORY_LIFECYCLES[form] as readonly string[]).includes(status);
}

export function defaultMemoryLifecycle(
  form: MemoryForm,
): MemoryLifecycleStatus {
  switch (form) {
    case "assertion":
      return "current";
    case "occurrence":
      return "happened";
    case "inquiry":
      return "open";
    default:
      return "active";
  }
}

/** Stable JSON identity used to authorize frozen evidence references. */
export function memorySourceKey(source: MemorySourceRef): string {
  if (source.type === "collection_record") {
    return JSON.stringify([
      source.type,
      source.collection,
      source.id,
      source.version ?? null,
      source.updatedAt ?? null,
      source.fragment ?? null,
    ]);
  }
  return JSON.stringify([source.type, source.id]);
}
