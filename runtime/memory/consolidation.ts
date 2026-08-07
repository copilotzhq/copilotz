import { estimateTextTokens } from "../tokens/index.ts";

export const MEMORY_RELATION_TYPES: readonly [
  "mentions",
  "related_to",
  "supports",
  "contradicts",
  "depends_on",
  "supersedes",
] = Object.freeze(
  [
    "mentions",
    "related_to",
    "supports",
    "contradicts",
    "depends_on",
    "supersedes",
  ] as const,
);

export type MemoryRelationType = typeof MEMORY_RELATION_TYPES[number];

const KNOWLEDGE_KINDS = new Set([
  "entity",
  "fact",
  "claim",
  "decision",
  "preference",
  "task",
  "event",
  "constraint",
]);

const WORKING_FIELD_META = {
  intent: {
    challenge: { kind: "challenge", label: "Challenge" },
    purpose: { kind: "purpose", label: "Purpose" },
    desiredOutcome: { kind: "desired_outcome", label: "Desired outcome" },
    successCriteria: {
      kind: "success_criterion",
      label: "Success criterion",
    },
    decisionCriteria: {
      kind: "decision_criterion",
      label: "Decision criterion",
    },
    constraints: { kind: "constraint", label: "Constraint" },
  },
  state: {
    currentState: { kind: "current_state", label: "Current state" },
    activeApproach: { kind: "active_approach", label: "Active approach" },
    risksAndBlockers: { kind: "risk", label: "Risk or blocker" },
    openQuestions: { kind: "open_question", label: "Open question" },
    nextActions: { kind: "next_action", label: "Next action" },
  },
} as const;

type ContinuityValueKind = "nullable_string" | "string_list";

const CONTINUITY_FIELD_KINDS = {
  intent: {
    challenge: "nullable_string",
    purpose: "nullable_string",
    desiredOutcome: "nullable_string",
    successCriteria: "string_list",
    decisionCriteria: "string_list",
    constraints: "string_list",
  },
  state: {
    currentState: "nullable_string",
    activeApproach: "nullable_string",
    risksAndBlockers: "string_list",
    openQuestions: "string_list",
    nextActions: "string_list",
  },
} as const satisfies Record<
  "intent" | "state",
  Record<string, ContinuityValueKind>
>;

export type SourcedContinuityValue<T> = Readonly<{
  value: T;
  sourceMessageIds: readonly string[];
}>;

export type LongTermMemoryContinuity = Readonly<{
  intent: Readonly<{
    challenge: SourcedContinuityValue<string | null>;
    purpose: SourcedContinuityValue<string | null>;
    desiredOutcome: SourcedContinuityValue<string | null>;
    successCriteria: SourcedContinuityValue<readonly string[]>;
    decisionCriteria: SourcedContinuityValue<readonly string[]>;
    constraints: SourcedContinuityValue<readonly string[]>;
  }>;
  state: Readonly<{
    currentState: SourcedContinuityValue<string | null>;
    activeApproach: SourcedContinuityValue<string | null>;
    risksAndBlockers: SourcedContinuityValue<readonly string[]>;
    openQuestions: SourcedContinuityValue<readonly string[]>;
    nextActions: SourcedContinuityValue<readonly string[]>;
  }>;
}>;

export type LongTermMemoryContinuityPatch = Readonly<{
  intent?: Partial<LongTermMemoryContinuity["intent"]>;
  state?: Partial<LongTermMemoryContinuity["state"]>;
}>;

export type MemoryConsolidationNode = Readonly<{
  localId: string;
  kind: string;
  name: string;
  content: string;
  confidence?: number;
  sourceMessageIds: readonly string[];
  memorySpaceId: string;
  supersedesNodeId?: string;
}>;

export type MemoryConsolidationRelation = Readonly<{
  source: string;
  type: MemoryRelationType;
  target: string;
}>;

export type MemoryConsolidationProposal = Readonly<{
  continuityPatch: LongTermMemoryContinuityPatch;
  nodes: readonly MemoryConsolidationNode[];
  relations: readonly MemoryConsolidationRelation[];
}>;

export type MemoryBrainNode = Readonly<{
  id: string;
  name: string;
  content: string;
  kind: string;
  memorySpaceId: string;
}>;

export type RetrievedMemoryBrainNode = Readonly<{
  node: MemoryBrainNode;
  similarity: number;
}>;

export type MemoryBrainRelation = Readonly<{
  sourceNodeId: string;
  targetNodeId: string;
  type: string;
}>;

export type WorkingMemoryNodeDraft = Readonly<{
  localId: string;
  kind: string;
  name: string;
  content: string;
  sourceMessageIds: readonly string[];
  memorySpaceId: string;
  sourceField: string;
}>;

export type MemorySourceMessage = Readonly<{
  id: string;
  senderType: string;
  senderId: string;
  text: string;
  toolCalls?: unknown;
  reasoning?: string;
}>;

export type SelectedMemoryRange = Readonly<{
  messages: readonly MemorySourceMessage[];
  estimatedTokens: number;
  retainedEstimatedTokens: number;
  retainedMessageCount: number;
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

const BRAIN_NODE_ID_PATTERN = /^- \[id:([^\]\s]+)\]/gm;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clampConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null;
}

function emptySourcedValue<T>(value: T): SourcedContinuityValue<T> {
  return Object.freeze({ value, sourceMessageIds: Object.freeze([]) });
}

export function createEmptyContinuity(): LongTermMemoryContinuity {
  return Object.freeze({
    intent: Object.freeze({
      challenge: emptySourcedValue<string | null>(null),
      purpose: emptySourcedValue<string | null>(null),
      desiredOutcome: emptySourcedValue<string | null>(null),
      successCriteria: emptySourcedValue<readonly string[]>([]),
      decisionCriteria: emptySourcedValue<readonly string[]>([]),
      constraints: emptySourcedValue<readonly string[]>([]),
    }),
    state: Object.freeze({
      currentState: emptySourcedValue<string | null>(null),
      activeApproach: emptySourcedValue<string | null>(null),
      risksAndBlockers: emptySourcedValue<readonly string[]>([]),
      openQuestions: emptySourcedValue<readonly string[]>([]),
      nextActions: emptySourcedValue<readonly string[]>([]),
    }),
  });
}

function normalizeStringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const normalized = value.map((entry) =>
    typeof entry === "string" ? entry.trim() : ""
  );
  if (normalized.some((entry) => !entry)) return null;
  return Object.freeze(
    normalized.filter((entry, index, values) =>
      values.indexOf(entry) === index
    ),
  );
}

function parseSourcedContinuityValue(
  candidate: unknown,
  kind: ContinuityValueKind,
  allowedSourceMessageIds?: ReadonlySet<string>,
  requireSource = false,
): SourcedContinuityValue<string | null | readonly string[]> | null {
  const value = record(candidate);
  if (!Array.isArray(value.sourceMessageIds)) return null;
  const sourceMessageIds = Object.freeze(
    value.sourceMessageIds
      .filter((id): id is string =>
        typeof id === "string" && id.length > 0 &&
        (!allowedSourceMessageIds || allowedSourceMessageIds.has(id))
      )
      .filter((id, index, ids) => ids.indexOf(id) === index),
  );
  if (requireSource && sourceMessageIds.length === 0) return null;
  if (kind === "nullable_string") {
    if (value.value === null) {
      return Object.freeze({ value: null, sourceMessageIds });
    }
    const text = typeof value.value === "string" ? value.value.trim() : "";
    return text ? Object.freeze({ value: text, sourceMessageIds }) : null;
  }
  const values = normalizeStringList(value.value);
  return values ? Object.freeze({ value: values, sourceMessageIds }) : null;
}

function parseContinuitySection(
  candidate: unknown,
  kinds: Readonly<Record<string, ContinuityValueKind>>,
  allowedSourceMessageIds?: ReadonlySet<string>,
  requireSource = false,
): Record<string, SourcedContinuityValue<string | null | readonly string[]>> {
  if (candidate === undefined) return {};
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Invalid long-term-memory continuity section.");
  }
  const source = candidate as Record<string, unknown>;
  const parsed: Record<
    string,
    SourcedContinuityValue<string | null | readonly string[]>
  > = {};
  for (const [field, kind] of Object.entries(kinds)) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const value = parseSourcedContinuityValue(
      source[field],
      kind,
      allowedSourceMessageIds,
      requireSource,
    );
    if (!value) {
      throw new Error(`Invalid long-term-memory continuity field: ${field}`);
    }
    parsed[field] = value;
  }
  return parsed;
}

function parseContinuityPatch(
  candidate: unknown,
  allowedSourceMessageIds: ReadonlySet<string>,
): LongTermMemoryContinuityPatch {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Invalid long-term-memory continuity patch.");
  }
  const source = candidate as Record<string, unknown>;
  return Object.freeze({
    ...(source.intent !== undefined
      ? {
        intent: parseContinuitySection(
          source.intent,
          CONTINUITY_FIELD_KINDS.intent,
          allowedSourceMessageIds,
          true,
        ) as LongTermMemoryContinuityPatch["intent"],
      }
      : {}),
    ...(source.state !== undefined
      ? {
        state: parseContinuitySection(
          source.state,
          CONTINUITY_FIELD_KINDS.state,
          allowedSourceMessageIds,
          true,
        ) as LongTermMemoryContinuityPatch["state"],
      }
      : {}),
  });
}

export function applyContinuityPatch(
  previous: LongTermMemoryContinuity,
  patch: LongTermMemoryContinuityPatch,
): LongTermMemoryContinuity {
  return Object.freeze({
    intent: Object.freeze({ ...previous.intent, ...(patch.intent ?? {}) }),
    state: Object.freeze({ ...previous.state, ...(patch.state ?? {}) }),
  });
}

export function readContinuity(value: unknown): LongTermMemoryContinuity {
  const fallback = createEmptyContinuity();
  const candidate = record(value);
  if (!Object.keys(candidate).length) return fallback;
  try {
    return applyContinuityPatch(fallback, {
      intent: parseContinuitySection(
        candidate.intent,
        CONTINUITY_FIELD_KINDS.intent,
      ) as LongTermMemoryContinuityPatch["intent"],
      state: parseContinuitySection(
        candidate.state,
        CONTINUITY_FIELD_KINDS.state,
      ) as LongTermMemoryContinuityPatch["state"],
    });
  } catch {
    return fallback;
  }
}

function continuityText(
  value: SourcedContinuityValue<string | null | readonly string[]>,
): readonly string[] {
  return Array.isArray(value.value)
    ? value.value
    : value.value
    ? [value.value as string]
    : [];
}

export function buildContinuityRetrievalTexts(
  continuity: LongTermMemoryContinuity,
): readonly string[] {
  const section = (
    values: Readonly<
      Record<
        string,
        SourcedContinuityValue<string | null | readonly string[]>
      >
    >,
  ) =>
    Object.entries(values).flatMap(([field, value]) =>
      continuityText(value).map((text) => `${field}: ${text}`)
    );
  const intent = section(continuity.intent);
  const state = section(continuity.state);
  return Object.freeze([
    intent.length ? intent.join("\n") : "",
    state.length ? state.join("\n") : "",
  ].filter(Boolean));
}

export function createWorkingMemoryNodeDrafts(
  continuity: LongTermMemoryContinuity,
  memorySpaceId: string,
): readonly WorkingMemoryNodeDraft[] {
  const drafts: WorkingMemoryNodeDraft[] = [];
  for (const section of ["intent", "state"] as const) {
    for (const [field, meta] of Object.entries(WORKING_FIELD_META[section])) {
      const value = (continuity[section] as Readonly<
        Record<
          string,
          SourcedContinuityValue<string | null | readonly string[]>
        >
      >)[field];
      if (!value) continue;
      const texts = continuityText(value);
      texts.forEach((content, index) =>
        drafts.push(Object.freeze({
          localId: `working:${section}.${field}:${index}`,
          kind: meta.kind,
          name: texts.length > 1 ? `${meta.label} ${index + 1}` : meta.label,
          content: content.trim(),
          sourceMessageIds: value.sourceMessageIds,
          memorySpaceId,
          sourceField: `${section}.${field}`,
        }))
      );
    }
  }
  return Object.freeze(drafts.filter((draft) => draft.content));
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return Object.keys(record(parsed)).length ? record(parsed) : null;
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return Object.keys(record(parsed)).length ? record(parsed) : null;
    } catch {
      return null;
    }
  }
}

export function parseMemoryConsolidationProposal(
  value: string,
  allowedSourceMessageIds: ReadonlySet<string>,
  allowedOlderNodeIds: ReadonlySet<string>,
  routing: Readonly<{
    writableMemorySpaceIds: ReadonlySet<string>;
    defaultWriteMemorySpaceId: string;
  }>,
): MemoryConsolidationProposal {
  const parsed = parseJsonObject(value);
  if (!parsed) {
    throw new Error("Invalid long-term-memory consolidation response.");
  }
  const continuityPatch = parseContinuityPatch(
    parsed.continuityPatch,
    allowedSourceMessageIds,
  );
  const rawNodes = Array.isArray(parsed.nodes)
    ? parsed.nodes
    : Array.isArray(parsed.items)
    ? parsed.items
    : [];
  const localIds = new Set<string>();
  const nodes = rawNodes.flatMap((candidate): MemoryConsolidationNode[] => {
    const source = record(candidate);
    const localId = typeof source.localId === "string"
      ? source.localId.trim()
      : "";
    const kind = typeof source.kind === "string" ? source.kind.trim() : "";
    const name = typeof source.name === "string" ? source.name.trim() : "";
    const content = typeof source.content === "string"
      ? source.content.trim()
      : "";
    if (
      !localId || localIds.has(localId) || !KNOWLEDGE_KINDS.has(kind) ||
      !name || !content
    ) return [];
    localIds.add(localId);
    const sourceMessageIds = Object.freeze(
      (Array.isArray(source.sourceMessageIds) ? source.sourceMessageIds : [])
        .filter((id): id is string =>
          typeof id === "string" && allowedSourceMessageIds.has(id)
        )
        .filter((id, index, ids) => ids.indexOf(id) === index),
    );
    const requestedSpace = typeof source.memorySpaceId === "string"
      ? source.memorySpaceId.trim()
      : "";
    const memorySpaceId = routing.writableMemorySpaceIds.has(requestedSpace)
      ? requestedSpace
      : routing.defaultWriteMemorySpaceId;
    const requestedSupersedes = typeof source.supersedesNodeId === "string"
      ? source.supersedesNodeId
      : typeof source.supersedesItemId === "string"
      ? source.supersedesItemId
      : "";
    const confidence = clampConfidence(source.confidence);
    return [Object.freeze({
      localId,
      kind,
      name,
      content,
      sourceMessageIds,
      memorySpaceId,
      ...(confidence !== null ? { confidence } : {}),
      ...(allowedOlderNodeIds.has(requestedSupersedes)
        ? { supersedesNodeId: requestedSupersedes }
        : {}),
    })];
  });
  const validTargets = new Set([...localIds, ...allowedOlderNodeIds]);
  const relations = (Array.isArray(parsed.relations) ? parsed.relations : [])
    .flatMap((candidate): MemoryConsolidationRelation[] => {
      const source = record(candidate);
      const from = typeof source.source === "string"
        ? source.source.trim()
        : "";
      const type = typeof source.type === "string" ? source.type.trim() : "";
      const target = typeof source.target === "string"
        ? source.target.trim()
        : "";
      if (
        !localIds.has(from) ||
        !MEMORY_RELATION_TYPES.includes(type as MemoryRelationType) ||
        !validTargets.has(target) || from === target
      ) return [];
      return [Object.freeze({
        source: from,
        type: type as MemoryRelationType,
        target,
      })];
    });
  return Object.freeze({
    continuityPatch,
    nodes: Object.freeze(nodes),
    relations: Object.freeze(relations),
  });
}

export function extractVisibleBrainNodeIds(content: string): readonly string[] {
  return Object.freeze(
    [...content.matchAll(BRAIN_NODE_ID_PATTERN)]
      .map((match) => match[1])
      .filter((id, index, ids) => ids.indexOf(id) === index),
  );
}

function renderContinuity(
  continuity: LongTermMemoryContinuity,
): readonly string[] {
  const scalar = (
    ref: string,
    label: string,
    value: SourcedContinuityValue<string | null>,
  ) => value.value ? [`- [continuity:${ref}] ${label}: ${value.value}`] : [];
  const list = (
    ref: string,
    label: string,
    value: SourcedContinuityValue<readonly string[]>,
  ) =>
    value.value.length
      ? [`- [continuity:${ref}] ${label}: ${value.value.join("; ")}`]
      : [];
  const intent = [
    ...scalar("intent.challenge", "Challenge", continuity.intent.challenge),
    ...scalar("intent.purpose", "Purpose", continuity.intent.purpose),
    ...scalar(
      "intent.desiredOutcome",
      "Desired outcome",
      continuity.intent.desiredOutcome,
    ),
    ...list(
      "intent.successCriteria",
      "Success criteria",
      continuity.intent.successCriteria,
    ),
    ...list(
      "intent.decisionCriteria",
      "Decision criteria",
      continuity.intent.decisionCriteria,
    ),
    ...list("intent.constraints", "Constraints", continuity.intent.constraints),
  ];
  const state = [
    ...scalar(
      "state.currentState",
      "Current state",
      continuity.state.currentState,
    ),
    ...scalar(
      "state.activeApproach",
      "Active approach",
      continuity.state.activeApproach,
    ),
    ...list(
      "state.risksAndBlockers",
      "Risks and blockers",
      continuity.state.risksAndBlockers,
    ),
    ...list(
      "state.openQuestions",
      "Open questions",
      continuity.state.openQuestions,
    ),
    ...list("state.nextActions", "Next actions", continuity.state.nextActions),
  ];
  return Object.freeze([
    "## CONTINUITY",
    "### Intent",
    ...(intent.length ? intent : ["- No explicit intent recorded."]),
    "### Current state",
    ...(state.length ? state : ["- No explicit current state recorded."]),
  ]);
}

export function renderLongTermMemory(
  input: Readonly<{
    proposal: MemoryConsolidationProposal;
    continuity: LongTermMemoryContinuity;
    newBrainNodes: ReadonlyMap<string, MemoryBrainNode>;
    olderBrainNodes: readonly RetrievedMemoryBrainNode[];
    olderRelations: readonly MemoryBrainRelation[];
    maxContentEstimatedTokens: number;
  }>,
): string {
  const names = new Map(input.olderBrainNodes.map((item) => [
    item.node.id,
    item.node.name,
  ]));
  const superseded = new Set(
    input.proposal.nodes.flatMap((node) =>
      node.supersedesNodeId ? [node.supersedesNodeId] : []
    ),
  );
  const relevant = [
    ...input.proposal.nodes.map((node) => {
      const persisted = input.newBrainNodes.get(node.localId);
      return `- [id:${
        persisted?.id ?? node.localId
      }] [${node.kind}] ${node.name}: ${node.content}`;
    }),
    ...input.olderBrainNodes
      .filter((item) => !superseded.has(item.node.id))
      .map((item) =>
        `- [id:${item.node.id}] [${item.node.kind}] ${item.node.name}: ${item.node.content}`
      ),
  ];
  const relationLines = [
    ...input.proposal.relations.map((relation) => {
      const source = input.newBrainNodes.get(relation.source)?.name ??
        relation.source;
      const target = input.newBrainNodes.get(relation.target)?.name ??
        names.get(relation.target) ?? relation.target;
      return `- ${source} --${relation.type}--> ${target}`;
    }),
    ...input.olderRelations.map((relation) =>
      `- ${
        names.get(relation.sourceNodeId) ?? relation.sourceNodeId
      } --${relation.type}--> ${
        names.get(relation.targetNodeId) ?? relation.targetNodeId
      }`
    ),
  ];
  const blocks = [
    "## LONG-TERM CONVERSATION MEMORY",
    ...renderContinuity(input.continuity),
    "## RELEVANT MEMORY",
    ...(relevant.length ? relevant : ["- No durable brain nodes."]),
    "## RELATIONSHIPS",
    ...(relationLines.length
      ? relationLines
      : ["- No explicit relationships."]),
  ];
  const retained: string[] = [];
  for (const block of blocks) {
    const candidate = [...retained, block].join("\n");
    if (estimateTextTokens(candidate) <= input.maxContentEstimatedTokens) {
      retained.push(block);
    }
  }
  return retained.join("\n");
}

function sourceMessageTokens(message: MemorySourceMessage): number {
  return estimateTextTokens(
    [
      message.senderType,
      message.senderId,
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
  }>,
): SelectedMemoryRange | null {
  const triggerIndex = input.messages.findIndex((message) =>
    message.id === input.triggerMessageId
  );
  if (triggerIndex < 0) return null;
  const selectedNewestFirst: MemorySourceMessage[] = [];
  let estimatedTokens = 0;
  let foundBoundary = !input.previousBoundaryMessageId;
  for (let index = triggerIndex; index >= 0; index--) {
    const message = input.messages[index];
    if (message.id === input.previousBoundaryMessageId) {
      foundBoundary = true;
      break;
    }
    selectedNewestFirst.push(message);
    estimatedTokens += sourceMessageTokens(message);
    if (
      !input.previousBoundaryMessageId &&
      estimatedTokens >= input.triggerEstimatedTokens
    ) break;
  }
  if (
    !foundBoundary || estimatedTokens < input.triggerEstimatedTokens ||
    selectedNewestFirst.length === 0
  ) return null;
  const selected = selectedNewestFirst.reverse();
  const retainTarget = Math.max(0, input.retainRecentEstimatedTokens ?? 0);
  let retainedEstimatedTokens = 0;
  let retainedMessageCount = 0;
  if (retainTarget > 0) {
    const units: MemorySourceMessage[][] = [];
    for (const message of selected) {
      if (message.senderType === "tool" && units.length) {
        units[units.length - 1].push(message);
      } else {
        units.push([message]);
      }
    }
    for (
      let index = units.length - 1;
      index >= 0 && retainedEstimatedTokens < retainTarget;
      index--
    ) {
      retainedEstimatedTokens += units[index].reduce(
        (total, message) => total + sourceMessageTokens(message),
        0,
      );
      retainedMessageCount += units[index].length;
    }
  }
  const messages = retainedMessageCount
    ? selected.slice(0, -retainedMessageCount)
    : selected;
  if (!messages.length) return null;
  return Object.freeze({
    messages: Object.freeze(messages),
    estimatedTokens,
    retainedEstimatedTokens,
    retainedMessageCount,
    sourceStartMessageId: messages[0].id,
    sourceEndMessageId: messages.at(-1)!.id,
  });
}

function sourcePreview(message: MemorySourceMessage): string | undefined {
  if (message.senderType === "tool") return "[tool result]";
  const compact = message.text.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

export function buildMemoryConsolidationInstruction(
  input: Readonly<{
    spaces: readonly MemorySpaceDescriptor[];
    sourceMessages: readonly MemorySourceMessage[];
    hasPreviousMemoryCheckpoint: boolean;
  }>,
): string {
  const defaultSpace = input.spaces.find((space) => space.defaultWrite);
  if (!defaultSpace || defaultSpace.access !== "read_write") {
    throw new Error("Memory consolidation requires a default writable space.");
  }
  const sourceMap = input.sourceMessages.map((message) => ({
    messageId: message.id,
    senderType: message.senderType,
    senderId: message.senderId,
    ...(sourcePreview(message) ? { preview: sourcePreview(message) } : {}),
  }));
  const writable = input.spaces.filter((space) =>
    space.access === "read_write"
  );
  return [
    "You are performing long-term memory consolidation for the agent history immediately above.",
    "Do not answer the user, route the conversation, or call tools.",
    "Source message map for provenance:",
    JSON.stringify(sourceMap),
    "",
    "Update continuity and extract durable memory from that history.",
    "Emit only changed continuity fields; omitted fields retain their previous values.",
    "Use null or [] only when the source explicitly clears a value.",
    "Keep challenge, desired outcome, current state, blockers, questions, and next actions distinct.",
    "Create canonical entity nodes for durable people, organizations, projects, products, tools, APIs, documents, concepts, goals, and workstreams.",
    "Relate non-entity memories to their main entities with mentions where applicable.",
    input.hasPreviousMemoryCheckpoint
      ? "You may target only older brain-node IDs visible in the long-term memory section."
      : "There is no prior checkpoint; relation targets must be new localIds.",
    "Every sourceMessageIds value must occur in the source message map.",
    `Writable memory spaces: ${JSON.stringify(writable)}`,
    `Default writable memory space: ${defaultSpace.id}`,
    "Output only one JSON object with this shape:",
    JSON.stringify({
      continuityPatch: {
        intent: {
          challenge: { value: "string|null", sourceMessageIds: ["id"] },
          purpose: { value: "string|null", sourceMessageIds: ["id"] },
          desiredOutcome: { value: "string|null", sourceMessageIds: ["id"] },
          successCriteria: { value: ["string"], sourceMessageIds: ["id"] },
          decisionCriteria: { value: ["string"], sourceMessageIds: ["id"] },
          constraints: { value: ["string"], sourceMessageIds: ["id"] },
        },
        state: {
          currentState: { value: "string|null", sourceMessageIds: ["id"] },
          activeApproach: { value: "string|null", sourceMessageIds: ["id"] },
          risksAndBlockers: { value: ["string"], sourceMessageIds: ["id"] },
          openQuestions: { value: ["string"], sourceMessageIds: ["id"] },
          nextActions: { value: ["string"], sourceMessageIds: ["id"] },
        },
      },
      nodes: [{
        localId: "local-id",
        kind: "entity|fact|claim|decision|preference|task|event|constraint",
        name: "short label",
        content: "self-contained statement",
        confidence: 0.9,
        sourceMessageIds: ["id"],
        memorySpaceId: defaultSpace.id,
        supersedesNodeId: "optional-visible-id",
      }],
      relations: [{
        source: "local-id",
        type: "mentions|related_to|supports|contradicts|depends_on|supersedes",
        target: "local-id-or-visible-id",
      }],
    }),
  ].join("\n");
}

export function stableMemoryNodeId(
  checkpointId: string,
  localId: string,
): string {
  return `${checkpointId}:brain:${encodeURIComponent(localId)}`;
}
