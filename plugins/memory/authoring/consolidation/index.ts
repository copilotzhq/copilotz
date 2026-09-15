/**
 * Consolidation parsing, instruction rendering, and deterministic projections.
 *
 * @module
 */

import type {
  ContextSourceRef,
  FrozenContextContribution,
} from "@copilotz/copilotz/core";
import { estimateTextTokens } from "@copilotz/copilotz/llm/tokens";
import {
  type AssertionMemoryDraft,
  type ConsolidateMemoryInput,
  type EntityMemoryDraft,
  type InquiryMemoryDraft,
  type IntentMemoryDraft,
  MEMORY_FORMS,
  type MemoryDraftBase,
  type MemoryForm,
  type MemoryKindDefinition,
  type MemoryLifecycleDraft,
  memorySourceKey,
  type OccurrenceMemoryDraft,
  type ProcedureMemoryDraft,
  type ProposedMemoryRef,
} from "../ontology/index.ts";
import { assertConsolidationInput } from "./schema.ts";

export type MemorySourceMessage = Readonly<{
  id: string;
  senderType: string;
  senderId: string;
  text: string;
  toolCalls?: unknown;
  toolPlanId?: string;
  toolCallId?: string;
  reasoning?: string;
}>;

export type SelectedMemoryRange = Readonly<{
  messages: readonly MemorySourceMessage[];
  estimatedTokens: number;
  retainedEstimatedTokens: number;
  retainedMessageCount: number;
  /** The next eligible source would exceed the single-turn source budget. */
  sourceLimitReached: boolean;
  sourceStartMessageId: string;
  sourceEndMessageId: string;
}>;

export type MemorySpaceDescriptor = Readonly<{
  id: string;
  name: string;
  description?: string | null;
  scopeType: string;
  access: "read" | "read_write";
  defaultWrite: boolean;
}>;

export type MemoryRecordProjection = Readonly<{
  id: string;
  memorySpaceId: string;
  form: MemoryForm;
  kind: string;
  summary: string;
  status: string;
  validity: "valid" | "retracted" | "superseded" | "archived";
  data: Readonly<Record<string, unknown>>;
}>;

/** True when a record is editorially usable in normal context and retrieval. */
export function isEditoriallyVisible(
  record: Pick<MemoryRecordProjection, "validity">,
): boolean {
  return record.validity === "valid";
}

export type RetrievedMemoryRecord = Readonly<{
  record: MemoryRecordProjection;
  similarity: number;
}>;

export type MemoryRecordRelation = Readonly<{
  sourceId: string;
  targetId: string;
  type: string;
}>;

type ParseConsolidationOptions = Readonly<{
  kinds: ReadonlyMap<string, MemoryKindDefinition>;
  writableMemorySpaceIds: ReadonlySet<string>;
  defaultWriteMemorySpaceId: string;
  allowedEvidenceSources: ReadonlySet<string>;
  /** Evidence used when a draft deliberately omits an explicit source list. */
  defaultEvidenceSources?: readonly ContextSourceRef[];
  visibleMemoryIds: ReadonlySet<string>;
  visibleNodeIds: ReadonlySet<string>;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(value: unknown, label: string): readonly string[] {
  if (value === undefined) return ([] as const);
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  const entries = value.map((item) => requiredText(item, label));
  return ([...new Set(entries)] as const);
}

function parseSource(value: unknown): ContextSourceRef {
  const input = record(value);
  const type = requiredText(input.type, "Memory source type");
  if (type === "collection_record") {
    return ({
      type,
      collection: requiredText(input.collection, "Memory source collection"),
      id: requiredText(input.id, "Memory source id"),
      ...(typeof input.version === "string" || typeof input.version === "number"
        ? { version: input.version }
        : {}),
      ...(optionalText(input.updatedAt)
        ? { updatedAt: optionalText(input.updatedAt) }
        : {}),
      ...(optionalText(input.fragment)
        ? { fragment: optionalText(input.fragment) }
        : {}),
    } as const);
  }
  if (
    type !== "message" && type !== "asset" &&
    type !== "external"
  ) {
    throw new TypeError(`Unsupported memory source type '${type}'.`);
  }
  return ({
    type,
    id: requiredText(input.id, "Memory source id"),
  } as ContextSourceRef);
}

function parseSources(
  value: unknown,
  options: ParseConsolidationOptions,
  label: string,
): readonly ContextSourceRef[] {
  if (value === undefined && options.defaultEvidenceSources?.length) {
    return (structuredClone(options.defaultEvidenceSources));
  }
  if (!Array.isArray(value) || !value.length) {
    throw new TypeError(`${label} requires at least one evidence source.`);
  }
  const result = value.map(parseSource);
  for (const source of result) {
    if (!options.allowedEvidenceSources.has(memorySourceKey(source))) {
      throw new TypeError(`${label} cites an unauthorized evidence source.`);
    }
  }
  return (result.filter((source, index) =>
    result.findIndex((candidate) =>
      memorySourceKey(candidate) === memorySourceKey(source)
    ) === index
  ));
}

function parseRef(
  value: unknown,
  localIds: ReadonlySet<string>,
  options: ParseConsolidationOptions,
  label: string,
): ProposedMemoryRef {
  const input = record(value);
  const localId = optionalText(input.localId);
  if (localId) {
    if (!localIds.has(localId)) {
      throw new TypeError(`${label} references unknown localId '${localId}'.`);
    }
    return ({ localId } as const);
  }
  const memoryId = optionalText(input.memoryId);
  if (memoryId) {
    if (!options.visibleMemoryIds.has(memoryId)) {
      throw new TypeError(
        `${label} references memory '${memoryId}' that was not visible.`,
      );
    }
    return ({ memoryId } as const);
  }
  const node = record(input.node);
  if (Object.keys(node).length) {
    const parsed = {
      type: requiredText(node.type, `${label} node type`),
      id: requiredText(node.id, `${label} node id`),
    } as const;
    if (!options.visibleNodeIds.has(`${parsed.type}:${parsed.id}`)) {
      throw new TypeError(
        `${label} references a domain node that was not visible.`,
      );
    }
    return ({ node: parsed } as const);
  }
  throw new TypeError(`${label} requires localId, memoryId, or node.`);
}

function parseBase(
  value: unknown,
  form: MemoryForm,
  options: ParseConsolidationOptions,
): MemoryDraftBase & { source: Record<string, unknown> } {
  const source = record(value);
  const localId = requiredText(source.localId, `${form} localId`);
  const kind = requiredText(source.kind, `${form} kind`);
  const definition = options.kinds.get(kind);
  if (!definition || definition.form !== form) {
    throw new TypeError(
      `Memory kind '${kind}' is not registered for form '${form}'.`,
    );
  }
  const requestedSpace = optionalText(source.spaceId);
  if (requestedSpace && !options.writableMemorySpaceIds.has(requestedSpace)) {
    throw new TypeError(
      `${form} '${localId}' references a memory space that is not writable.`,
    );
  }
  const spaceId = requestedSpace ?? options.defaultWriteMemorySpaceId;
  if (
    source.attributes !== undefined &&
    (!source.attributes || typeof source.attributes !== "object" ||
      Array.isArray(source.attributes))
  ) {
    throw new TypeError(`${form} '${localId}' attributes must be an object.`);
  }
  return {
    localId,
    kind,
    summary: requiredText(source.summary, `${form} summary`),
    spaceId,
    sources: parseSources(source.sources, options, `${form} '${localId}'`),
    ...(source.attributes
      ? {
        attributes: structuredClone(record(source.attributes)),
      }
      : {}),
    source,
  };
}

function parseTemporal(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  const result = Object.fromEntries(
    Object.entries(input).flatMap(([key, item]) =>
      optionalText(item) ? [[key, optionalText(item)!]] : []
    ),
  );
  return Object.keys(result).length ? result : undefined;
}

/** Structural shape is validated once; this pass normalizes values and enforces authority. */
function normalizeDraft(
  value: unknown,
  form: MemoryForm,
  localIds: ReadonlySet<string>,
  options: ParseConsolidationOptions,
): MemoryDraftBase & Readonly<Record<string, unknown>> {
  const { source, ...base } = parseBase(value, form, options);
  const output: Record<string, unknown> = { ...source, ...base };
  for (const field of ["name", "predicate", "question"]) {
    if (field in source) {
      output[field] = requiredText(source[field], `${form} ${field}`);
    }
  }
  for (
    const field of ["dueAt", "trigger", "expectedOutcome", "applicability"]
  ) {
    if (!(field in source)) continue;
    const text = optionalText(source[field]);
    if (text) output[field] = text;
    else delete output[field];
  }
  for (const field of ["aliases", "preconditions", "steps"]) {
    if (field in source) {
      output[field] = uniqueStrings(source[field], `${form} ${field}`);
    }
  }
  for (const field of ["subject", "owner", "target", "answer"]) {
    if (field in source) {
      output[field] = parseRef(
        source[field],
        localIds,
        options,
        `${form} ${field}`,
      );
    }
  }
  for (const field of ["participants", "about"]) {
    if (field in source) {
      output[field] = (source[field] as readonly unknown[]).map((ref) =>
        parseRef(ref, localIds, options, `${form} ${field}`)
      );
    }
  }
  if (form === "assertion") {
    const object = record(source.object);
    output.object = "ref" in object
      ? ({
        ref: parseRef(object.ref, localIds, options, "Assertion object"),
      } as const)
      : ({ value: object.value } as const);
    output.epistemic = { ...record(source.epistemic) } as const;
  }
  if (source.temporal !== undefined) {
    const temporal = parseTemporal(source.temporal);
    if (temporal) output.temporal = temporal;
    else delete output.temporal;
  }
  if (source.externalIds !== undefined) {
    const entries = Object.entries(record(source.externalIds));
    if (entries.length) {
      output.externalIds = Object.fromEntries(
        entries.map((
          [key, value],
        ) => [
          requiredText(key, "Entity external id key"),
          requiredText(value, "Entity external id value"),
        ]),
      );
    } else delete output.externalIds;
  }
  return output as
    & MemoryDraftBase
    & Readonly<Record<string, unknown>>;
}

/** Validates and normalizes one model-authored consolidation tool call. */
export function parseConsolidateMemoryInput(
  value: unknown,
  options: ParseConsolidationOptions,
): ConsolidateMemoryInput {
  assertConsolidationInput(value, [...options.kinds.values()]);
  // This assertion follows the shared structural schema, never replaces validation.
  const input = structuredClone(value) as ConsolidateMemoryInput;
  const drafts = proposalDrafts(input);
  const localIds = new Set(
    drafts.map(({ draft }) => requiredText(draft.localId, "Memory localId")),
  );
  if (localIds.size !== drafts.length) {
    throw new TypeError("Memory proposal localIds must be unique.");
  }
  const output: Record<string, unknown> = {
    outcome: input.outcome,
    continuity: requiredText(input.continuity, "Memory continuity"),
  };
  const groups = {
    entity: "entities",
    assertion: "assertions",
    occurrence: "occurrences",
    intent: "intents",
    inquiry: "inquiries",
    procedure: "procedures",
  } as const;
  for (const form of MEMORY_FORMS) {
    const values = input[groups[form]];
    if (values?.length) {
      output[groups[form]] = values.map((draft) =>
        normalizeDraft(draft, form, localIds, options)
      );
    }
  }
  if (input.relations?.length) {
    output.relations = input.relations.map((relation) => ({
      from: parseRef(
        relation.from,
        localIds,
        options,
        "Memory relation source",
      ),
      type: relation.type,
      to: parseRef(
        relation.to,
        localIds,
        options,
        "Memory relation target",
      ),
      ...(relation.sources === undefined ? {} : {
        sources: parseSources(relation.sources, options, "Memory relation"),
      }),
    } as const));
  }
  if (input.lifecycle?.length) {
    output.lifecycle = input.lifecycle.map((change) => {
      let target: MemoryLifecycleDraft["target"];
      if ("memoryId" in change.target) {
        const memoryId = requiredText(
          change.target.memoryId,
          "Lifecycle target",
        );
        if (!options.visibleMemoryIds.has(memoryId)) {
          throw new TypeError(
            `Lifecycle target '${memoryId}' was not visible.`,
          );
        }
        target = { memoryId } as const;
      } else {
        const match = change.target.match;
        target = {
          match: {
            form: match.form,
            query: requiredText(match.query, "Lifecycle match query"),
            ...(optionalText(match.kind)
              ? { kind: optionalText(match.kind) }
              : {}),
            ...(optionalText(match.predicate)
              ? { predicate: optionalText(match.predicate) }
              : {}),
            ...(match.subject
              ? {
                subject: parseRef(
                  match.subject,
                  localIds,
                  options,
                  "Lifecycle match subject",
                ),
              }
              : {}),
          } as const,
        } as const;
      }
      return ({
        target,
        status: change.status,
        ...(change.replacement
          ? {
            replacement: parseRef(
              change.replacement,
              localIds,
              options,
              "Lifecycle replacement",
            ),
          }
          : {}),
        sources: parseSources(change.sources, options, "Lifecycle change"),
      } as const);
    });
  }
  return output as ConsolidateMemoryInput;
}

function sourceMessageTokens(message: MemorySourceMessage): number {
  return estimateTextTokens(
    [
      message.senderType,
      message.senderId,
      message.toolPlanId ?? "",
      message.toolCallId ?? "",
      message.text,
      message.toolCalls === undefined ? "" : JSON.stringify(message.toolCalls),
      message.reasoning ?? "",
    ].filter(Boolean).join("\n"),
  );
}

export function selectLongTermMemoryRange(
  input: Readonly<{
    messages: readonly MemorySourceMessage[];
    triggerMessageId: string;
    previousBoundaryMessageId?: string;
    triggerEstimatedTokens: number;
    retainRecentEstimatedTokens?: number;
    /** Maximum source size passed to a single maintenance turn. */
    maxSourceEstimatedTokens?: number;
  }>,
): SelectedMemoryRange | null {
  const triggerIndex = input.messages.findIndex((message) =>
    message.id === input.triggerMessageId
  );
  if (triggerIndex < 0) return null;
  const boundaryIndex = input.previousBoundaryMessageId === undefined
    ? -1
    : input.messages.findIndex((message) =>
      message.id === input.previousBoundaryMessageId
    );
  if (input.previousBoundaryMessageId !== undefined && boundaryIndex < 0) {
    return null;
  }
  // A certified checkpoint replaces a contiguous prefix. The first checkpoint
  // therefore begins with the first eligible message, never a recent suffix.
  const selected = input.messages.slice(boundaryIndex + 1, triggerIndex + 1);
  const estimatedTokens = selected.reduce(
    (total, message) => total + sourceMessageTokens(message),
    0,
  );
  if (estimatedTokens < input.triggerEstimatedTokens || !selected.length) {
    return null;
  }
  const retainTarget = Math.max(0, input.retainRecentEstimatedTokens ?? 0);
  let retainedEstimatedTokens = 0;
  let retainedMessageCount = 0;
  for (
    let index = selected.length - 1;
    index >= 0 && retainedEstimatedTokens < retainTarget;
    index--
  ) {
    retainedEstimatedTokens += sourceMessageTokens(selected[index]);
    retainedMessageCount++;
  }
  let end = retainedMessageCount
    ? selected.length - retainedMessageCount
    : selected.length;

  const maxSourceEstimatedTokens = input.maxSourceEstimatedTokens;
  let sourceLimitReached = false;
  if (maxSourceEstimatedTokens !== undefined) {
    let boundedEnd = 0;
    let boundedTokens = 0;
    for (let index = 0; index < end; index++) {
      boundedTokens += sourceMessageTokens(selected[index]);
      if (boundedTokens > maxSourceEstimatedTokens) break;
      boundedEnd = index + 1;
    }
    // Even the first source message is too large. Callers must
    // handle that overflow explicitly rather than discarding history.
    if (!boundedEnd) return null;
    sourceLimitReached = boundedEnd < end;
    end = boundedEnd;
  }

  const messages = selected.slice(0, end);
  if (!messages.length) return null;
  const retainedMessages = selected.slice(end);
  retainedEstimatedTokens = retainedMessages.reduce(
    (total, message) => total + sourceMessageTokens(message),
    0,
  );
  retainedMessageCount = retainedMessages.length;
  return ({
    messages: messages,
    estimatedTokens: messages.reduce(
      (total, message) => total + sourceMessageTokens(message),
      0,
    ),
    retainedEstimatedTokens,
    retainedMessageCount,
    sourceLimitReached,
    sourceStartMessageId: messages[0].id,
    sourceEndMessageId: messages.at(-1)!.id,
  } as const);
}

export function buildMemoryConsolidationInstruction(
  input: Readonly<{
    spaces: readonly MemorySpaceDescriptor[];
    sourceMessages: readonly MemorySourceMessage[];
    kinds: readonly MemoryKindDefinition[];
    previousRecords: readonly MemoryRecordProjection[];
    context: readonly FrozenContextContribution[];
    repair?: string;
  }>,
): string {
  const writable = input.spaces.filter((space) =>
    space.access === "read_write"
  );
  const defaultSpace = writable.find((space) => space.defaultWrite);
  if (!defaultSpace) {
    throw new Error("Memory consolidation requires a default writable space.");
  }
  return [
    "## Internal memory maintenance",
    "Copilotz reserved part of your conversation history for durable memory consolidation. This is internal maintenance, not a new user request.",
    'Review the reserved history using your normal identity and instructions. Call consolidate_memory exactly once. Every payload, including outcome no_changes, requires a non-empty continuity summary covering the complete reserved source range and reconciling any earlier continuity below. It will replace this compacted prefix: these source messages will no longer be directly present in the next prompt. Preserve the active task, constraints, decisions, useful results, outstanding work, uncertainty, and any tool/Ask identifiers needed to continue. Example when no durable record changes: {"outcome":"no_changes","continuity":"Continue the release validation. The output contract must include continuity; tests are pending. No durable memory record changed and no user answer is pending."}. Do not answer the user or continue the task.',
    "Extract only durable entities, assertions, meaningful occurrences, active intents, unresolved inquiries, and reusable procedures. Every record must be self-contained and cite allowed sources. Preserve uncertainty, negation, temporal meaning, authorship, and explicit corrections. Do not turn tentative language into facts, silently overwrite conflicts, create an entity for every noun, or persist small talk, raw tool output, token deltas, and transient wording. Use the default writable memory space unless another listed writable space clearly owns the record.",
    input.repair ? `Repair required: ${input.repair}` : "",
    "Reserved source messages (complete bounded contents):",
    JSON.stringify(input.sourceMessages.map((message) => ({
      type: "message",
      id: message.id,
      senderType: message.senderType,
      senderId: message.senderId,
      text: message.text,
      ...(message.toolPlanId ? { toolPlanId: message.toolPlanId } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolCalls === undefined
        ? {}
        : { toolCalls: message.toolCalls }),
      ...(message.reasoning === undefined
        ? {}
        : { reasoning: message.reasoning }),
    }))),
    "Frozen application contributions:",
    JSON.stringify(input.context.map((item) => ({
      id: item.id,
      title: item.title,
      role: item.role,
      source: item.source,
      capturedAt: item.capturedAt,
    }))),
    "Writable memory spaces:",
    JSON.stringify(writable),
    `Default writable memory space: ${defaultSpace.id}`,
    "Registered memory kinds:",
    JSON.stringify(
      input.kinds.map(({ id, form, description, schema }) => ({
        id,
        form,
        description,
        ...(schema ? { persistedDataSchema: schema } : {}),
      })),
    ),
    "Visible previous active memories:",
    JSON.stringify(
      input.previousRecords.map(({ id, form, kind, summary, status }) => ({
        id,
        form,
        kind,
        summary,
        status,
      })),
    ),
  ].filter(Boolean).join("\n\n");
}

export function stableMemoryRecordId(
  checkpointId: string,
  localId: string,
): string {
  return `${checkpointId}:record:${encodeURIComponent(localId)}`;
}

function continuityGroup(
  records: readonly MemoryRecordProjection[],
  form: MemoryForm,
  kinds: readonly string[],
) {
  return records.filter((item) =>
    item.form === form && kinds.includes(item.kind)
  ).map((item) => `- [id:${item.id}] [${item.kind}] ${item.summary}`);
}

/** Renders the bounded derived continuity and retrieval view used in prompts. */
export function renderLongTermMemory(
  input: Readonly<{
    records: readonly MemoryRecordProjection[];
    relations: readonly MemoryRecordRelation[];
    maxContentEstimatedTokens: number;
  }>,
): string {
  const current = input.records.filter((item) =>
    isEditoriallyVisible(item) && ![
      "superseded",
      "retracted",
      "cancelled",
      "obsolete",
      "deprecated",
      "merged",
      "archived",
    ].includes(item.status)
  );
  const names = new Map(current.map((item) => [item.id, item.summary]));
  const sections = [
    "## LONG-TERM CONVERSATION MEMORY",
    "## CONTINUITY",
    "### Objectives and purpose",
    ...(continuityGroup(current, "intent", [
        "intent.purpose",
        "intent.objective",
      ]).length
      ? continuityGroup(current, "intent", [
        "intent.purpose",
        "intent.objective",
      ])
      : ["- None recorded."]),
    "### Decisions, plans, and actions",
    ...(continuityGroup(current, "intent", [
        "intent.decision",
        "intent.plan",
        "intent.action",
      ]).length
      ? continuityGroup(current, "intent", [
        "intent.decision",
        "intent.plan",
        "intent.action",
      ])
      : ["- None recorded."]),
    "### Current state, constraints, and risks",
    ...(continuityGroup(current, "assertion", [
        "assertion.state",
        "assertion.constraint",
        "assertion.risk",
      ]).length
      ? continuityGroup(current, "assertion", [
        "assertion.state",
        "assertion.constraint",
        "assertion.risk",
      ])
      : ["- None recorded."]),
    "### Open inquiries",
    ...(continuityGroup(current, "inquiry", [
        "inquiry.question",
        "inquiry.unknown",
        "inquiry.validation_needed",
      ]).length
      ? continuityGroup(current, "inquiry", [
        "inquiry.question",
        "inquiry.unknown",
        "inquiry.validation_needed",
      ])
      : ["- None recorded."]),
    "## RELEVANT MEMORY",
    ...current.map((item) =>
      `- [id:${item.id}] [${item.form}/${item.kind}; ${item.status}] ${item.summary}`
    ),
    "## RELATIONSHIPS",
    ...(input.relations.length
      ? input.relations.map((relation) =>
        `- ${
          names.get(relation.sourceId) ?? relation.sourceId
        } --${relation.type}--> ${
          names.get(relation.targetId) ?? relation.targetId
        }`
      )
      : ["- No explicit relationships."]),
  ];
  const selected: string[] = [];
  for (const section of sections) {
    if (
      estimateTextTokens([...selected, section].join("\n")) <=
        input.maxContentEstimatedTokens
    ) selected.push(section);
  }
  return selected.join("\n");
}

export function proposalDrafts(
  input: ConsolidateMemoryInput,
): readonly Readonly<{
  form: MemoryForm;
  draft:
    | EntityMemoryDraft
    | AssertionMemoryDraft
    | OccurrenceMemoryDraft
    | IntentMemoryDraft
    | InquiryMemoryDraft
    | ProcedureMemoryDraft;
}>[] {
  return ([
    ...(input.entities ?? []).map((draft) => ({
      form: "entity" as const,
      draft,
    })),
    ...(input.assertions ?? []).map((draft) => ({
      form: "assertion" as const,
      draft,
    })),
    ...(input.occurrences ?? []).map((draft) => ({
      form: "occurrence" as const,
      draft,
    })),
    ...(input.intents ?? []).map((draft) => ({
      form: "intent" as const,
      draft,
    })),
    ...(input.inquiries ?? []).map((draft) => ({
      form: "inquiry" as const,
      draft,
    })),
    ...(input.procedures ?? []).map((draft) => ({
      form: "procedure" as const,
      draft,
    })),
  ] as const);
}
