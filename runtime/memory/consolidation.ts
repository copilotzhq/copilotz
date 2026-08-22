import { estimateTextTokens } from "../tokens/index.ts";
import type { FrozenContextContribution } from "../context/index.ts";
import {
  type AssertionMemoryDraft,
  type ConsolidateMemoryInput,
  type EntityMemoryDraft,
  type InquiryMemoryDraft,
  type IntentMemoryDraft,
  MEMORY_FORMS,
  MEMORY_RELATION_TYPES,
  type MemoryDraftBase,
  type MemoryForm,
  type MemoryKindDefinition,
  type MemoryLifecycleDraft,
  type MemoryRelationDraft,
  memorySourceKey,
  type MemorySourceRef,
  type OccurrenceMemoryDraft,
  type ProcedureMemoryDraft,
  type ProposedMemoryRef,
} from "./ontology.ts";

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

export type MemoryRecordProjection = Readonly<{
  id: string;
  memorySpaceId: string;
  form: MemoryForm;
  kind: string;
  summary: string;
  status: string;
  data: Readonly<Record<string, unknown>>;
}>;

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
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  const entries = value.map((item) => requiredText(item, label));
  return Object.freeze([...new Set(entries)]);
}

function parseSource(value: unknown): MemorySourceRef {
  const input = record(value);
  const type = requiredText(input.type, "Memory source type");
  if (type === "collection_record") {
    return Object.freeze({
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
    });
  }
  if (
    type !== "message" && type !== "asset" &&
    type !== "external"
  ) {
    throw new TypeError(`Unsupported memory source type '${type}'.`);
  }
  return Object.freeze({
    type,
    id: requiredText(input.id, "Memory source id"),
  } as MemorySourceRef);
}

function parseSources(
  value: unknown,
  options: ParseConsolidationOptions,
  label: string,
): readonly MemorySourceRef[] {
  if (!Array.isArray(value) || !value.length) {
    throw new TypeError(`${label} requires at least one evidence source.`);
  }
  const result = value.map(parseSource);
  for (const source of result) {
    if (!options.allowedEvidenceSources.has(memorySourceKey(source))) {
      throw new TypeError(`${label} cites an unauthorized evidence source.`);
    }
  }
  return Object.freeze(
    result.filter((source, index) =>
      result.findIndex((candidate) =>
        memorySourceKey(candidate) === memorySourceKey(source)
      ) === index
    ),
  );
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
    return Object.freeze({ localId });
  }
  const memoryId = optionalText(input.memoryId);
  if (memoryId) {
    if (!options.visibleMemoryIds.has(memoryId)) {
      throw new TypeError(
        `${label} references memory '${memoryId}' that was not visible.`,
      );
    }
    return Object.freeze({ memoryId });
  }
  const node = record(input.node);
  if (Object.keys(node).length) {
    const parsed = Object.freeze({
      type: requiredText(node.type, `${label} node type`),
      id: requiredText(node.id, `${label} node id`),
    });
    if (!options.visibleNodeIds.has(`${parsed.type}:${parsed.id}`)) {
      throw new TypeError(
        `${label} references a domain node that was not visible.`,
      );
    }
    return Object.freeze({ node: parsed });
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
        attributes: Object.freeze(structuredClone(record(source.attributes))),
      }
      : {}),
    source,
  };
}

function parseEpistemic(value: unknown) {
  const input = record(value);
  const basis = requiredText(input.basis, "Assertion epistemic basis");
  const stance = requiredText(input.stance, "Assertion epistemic stance");
  if (!["observed", "reported", "inferred", "assumed"].includes(basis)) {
    throw new TypeError(`Invalid assertion epistemic basis '${basis}'.`);
  }
  if (!["affirmed", "denied", "tentative", "disputed"].includes(stance)) {
    throw new TypeError(`Invalid assertion epistemic stance '${stance}'.`);
  }
  return Object.freeze({ basis, stance }) as AssertionMemoryDraft["epistemic"];
}

function parseDrafts<T>(
  value: unknown,
  form: MemoryForm,
  parse: (base: ReturnType<typeof parseBase>) => T,
  options: ParseConsolidationOptions,
): readonly T[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new TypeError(`${form} drafts must be an array.`);
  }
  return Object.freeze(
    value.map((candidate) => parse(parseBase(candidate, form, options))),
  );
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
  return Object.keys(result).length ? Object.freeze(result) : undefined;
}

/** Validates and normalizes one model-authored consolidation tool call. */
export function parseConsolidateMemoryInput(
  value: unknown,
  options: ParseConsolidationOptions,
): ConsolidateMemoryInput {
  const input = record(value);
  if (input.outcome !== "changes" && input.outcome !== "no_changes") {
    throw new TypeError(
      "consolidate_memory outcome must be 'changes' or 'no_changes'.",
    );
  }

  const rawGroups = [
    input.entities,
    input.assertions,
    input.occurrences,
    input.intents,
    input.inquiries,
    input.procedures,
  ];
  const rawLocalIds = rawGroups.flatMap((group) =>
    Array.isArray(group)
      ? group.map((item) => optionalText(record(item).localId)).filter((
        id,
      ): id is string => Boolean(id))
      : []
  );
  if (new Set(rawLocalIds).size !== rawLocalIds.length) {
    throw new TypeError("Memory proposal localIds must be unique.");
  }
  const localIds = new Set(rawLocalIds);

  const entities = parseDrafts<EntityMemoryDraft>(
    input.entities,
    "entity",
    (base) =>
      Object.freeze({
        localId: base.localId,
        kind: base.kind,
        summary: base.summary,
        spaceId: base.spaceId,
        sources: base.sources,
        ...(base.attributes ? { attributes: base.attributes } : {}),
        name: requiredText(base.source.name, `Entity '${base.localId}' name`),
        ...(base.source.aliases !== undefined
          ? {
            aliases: uniqueStrings(
              base.source.aliases,
              `Entity '${base.localId}' aliases`,
            ),
          }
          : {}),
        ...(Object.keys(record(base.source.externalIds)).length
          ? {
            externalIds: Object.freeze(Object.fromEntries(
              Object.entries(record(base.source.externalIds)).map((
                [key, item],
              ) => [
                requiredText(key, "Entity external id key"),
                requiredText(item, "Entity external id value"),
              ]),
            )),
          }
          : {}),
      }),
    options,
  );

  const assertions = parseDrafts<AssertionMemoryDraft>(
    input.assertions,
    "assertion",
    (base) => {
      const object = record(base.source.object);
      const parsedObject = Object.prototype.hasOwnProperty.call(object, "ref")
        ? Object.freeze({
          ref: parseRef(
            object.ref,
            localIds,
            options,
            `Assertion '${base.localId}' object`,
          ),
        })
        : Object.prototype.hasOwnProperty.call(object, "value") &&
            (object.value === null ||
              ["string", "number", "boolean"].includes(typeof object.value))
        ? Object.freeze({
          value: object.value as string | number | boolean | null,
        })
        : (() => {
          throw new TypeError(
            `Assertion '${base.localId}' requires an object ref or scalar value.`,
          );
        })();
      return Object.freeze({
        localId: base.localId,
        kind: base.kind,
        summary: base.summary,
        spaceId: base.spaceId,
        sources: base.sources,
        ...(base.attributes ? { attributes: base.attributes } : {}),
        subject: parseRef(
          base.source.subject,
          localIds,
          options,
          `Assertion '${base.localId}' subject`,
        ),
        predicate: requiredText(
          base.source.predicate,
          `Assertion '${base.localId}' predicate`,
        ),
        object: parsedObject,
        epistemic: parseEpistemic(base.source.epistemic),
        ...(parseTemporal(base.source.temporal)
          ? { temporal: parseTemporal(base.source.temporal) }
          : {}),
      });
    },
    options,
  );

  const occurrences = parseDrafts<OccurrenceMemoryDraft>(
    input.occurrences,
    "occurrence",
    (base) =>
      Object.freeze({
        localId: base.localId,
        kind: base.kind,
        summary: base.summary,
        spaceId: base.spaceId,
        sources: base.sources,
        ...(base.attributes ? { attributes: base.attributes } : {}),
        ...(Array.isArray(base.source.participants)
          ? {
            participants: Object.freeze(base.source.participants.map((item) =>
              parseRef(
                item,
                localIds,
                options,
                `Occurrence '${base.localId}' participant`,
              )
            )),
          }
          : {}),
        ...(parseTemporal(base.source.temporal)
          ? { temporal: parseTemporal(base.source.temporal) }
          : {}),
      }),
    options,
  );

  const intents = parseDrafts<IntentMemoryDraft>(
    input.intents,
    "intent",
    (base) => {
      const status = requiredText(
        base.source.status,
        `Intent '${base.localId}' status`,
      );
      if (!["proposed", "active", "completed", "cancelled"].includes(status)) {
        throw new TypeError(
          `Intent '${base.localId}' has invalid status '${status}'.`,
        );
      }
      return Object.freeze({
        localId: base.localId,
        kind: base.kind,
        summary: base.summary,
        spaceId: base.spaceId,
        sources: base.sources,
        ...(base.attributes ? { attributes: base.attributes } : {}),
        status: status as IntentMemoryDraft["status"],
        ...(base.source.owner
          ? {
            owner: parseRef(
              base.source.owner,
              localIds,
              options,
              `Intent '${base.localId}' owner`,
            ),
          }
          : {}),
        ...(base.source.target
          ? {
            target: parseRef(
              base.source.target,
              localIds,
              options,
              `Intent '${base.localId}' target`,
            ),
          }
          : {}),
        ...(optionalText(base.source.dueAt)
          ? { dueAt: optionalText(base.source.dueAt) }
          : {}),
      });
    },
    options,
  );

  const inquiries = parseDrafts<InquiryMemoryDraft>(
    input.inquiries,
    "inquiry",
    (base) => {
      const status = requiredText(
        base.source.status,
        `Inquiry '${base.localId}' status`,
      );
      if (!["open", "answered", "obsolete"].includes(status)) {
        throw new TypeError(
          `Inquiry '${base.localId}' has invalid status '${status}'.`,
        );
      }
      return Object.freeze({
        localId: base.localId,
        kind: base.kind,
        summary: base.summary,
        spaceId: base.spaceId,
        sources: base.sources,
        ...(base.attributes ? { attributes: base.attributes } : {}),
        question: requiredText(
          base.source.question,
          `Inquiry '${base.localId}' question`,
        ),
        status: status as InquiryMemoryDraft["status"],
        ...(Array.isArray(base.source.about)
          ? {
            about: Object.freeze(
              base.source.about.map((item) =>
                parseRef(
                  item,
                  localIds,
                  options,
                  `Inquiry '${base.localId}' about`,
                )
              ),
            ),
          }
          : {}),
        ...(base.source.answer
          ? {
            answer: parseRef(
              base.source.answer,
              localIds,
              options,
              `Inquiry '${base.localId}' answer`,
            ),
          }
          : {}),
      });
    },
    options,
  );

  const procedures = parseDrafts<ProcedureMemoryDraft>(
    input.procedures,
    "procedure",
    (base) => {
      const steps = uniqueStrings(
        base.source.steps,
        `Procedure '${base.localId}' steps`,
      );
      if (!steps.length) {
        throw new TypeError(
          `Procedure '${base.localId}' requires at least one step.`,
        );
      }
      return Object.freeze({
        localId: base.localId,
        kind: base.kind,
        summary: base.summary,
        spaceId: base.spaceId,
        sources: base.sources,
        ...(base.attributes ? { attributes: base.attributes } : {}),
        steps,
        ...(optionalText(base.source.trigger)
          ? { trigger: optionalText(base.source.trigger) }
          : {}),
        ...(base.source.preconditions !== undefined
          ? {
            preconditions: uniqueStrings(
              base.source.preconditions,
              `Procedure '${base.localId}' preconditions`,
            ),
          }
          : {}),
        ...(optionalText(base.source.expectedOutcome)
          ? { expectedOutcome: optionalText(base.source.expectedOutcome) }
          : {}),
        ...(optionalText(base.source.applicability)
          ? { applicability: optionalText(base.source.applicability) }
          : {}),
      });
    },
    options,
  );

  const parseRelation = (value: unknown): MemoryRelationDraft => {
    const candidate = record(value);
    const type = requiredText(candidate.type, "Memory relation type");
    if (
      !MEMORY_RELATION_TYPES.includes(type as never) ||
      type === "derived_from" || type === "supersedes"
    ) throw new TypeError(`Memory relation type '${type}' cannot be proposed.`);
    return Object.freeze({
      from: parseRef(
        candidate.from,
        localIds,
        options,
        "Memory relation source",
      ),
      type: type as MemoryRelationDraft["type"],
      to: parseRef(candidate.to, localIds, options, "Memory relation target"),
      ...(candidate.sources !== undefined
        ? {
          sources: parseSources(candidate.sources, options, "Memory relation"),
        }
        : {}),
    });
  };
  const relations = input.relations === undefined
    ? Object.freeze([])
    : Array.isArray(input.relations)
    ? Object.freeze(input.relations.map(parseRelation))
    : (() => {
      throw new TypeError("Memory relations must be an array.");
    })();

  const parseLifecycle = (value: unknown): MemoryLifecycleDraft => {
    const candidate = record(value);
    const target = record(candidate.target);
    const memoryId = optionalText(target.memoryId);
    let parsedTarget: MemoryLifecycleDraft["target"];
    if (memoryId) {
      if (!options.visibleMemoryIds.has(memoryId)) {
        throw new TypeError(`Lifecycle target '${memoryId}' was not visible.`);
      }
      parsedTarget = Object.freeze({ memoryId });
    } else {
      const match = record(target.match);
      const form = requiredText(
        match.form,
        "Lifecycle match form",
      ) as MemoryForm;
      if (!MEMORY_FORMS.includes(form)) {
        throw new TypeError(`Invalid lifecycle match form '${form}'.`);
      }
      parsedTarget = Object.freeze({
        match: Object.freeze({
          form,
          ...(optionalText(match.kind)
            ? { kind: optionalText(match.kind) }
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
          ...(optionalText(match.predicate)
            ? { predicate: optionalText(match.predicate) }
            : {}),
          query: requiredText(match.query, "Lifecycle match query"),
        }),
      });
    }
    const status = requiredText(candidate.status, "Lifecycle status");
    if (
      ![
        "superseded",
        "retracted",
        "completed",
        "cancelled",
        "answered",
        "obsolete",
        "deprecated",
      ].includes(status)
    ) {
      throw new TypeError(`Invalid lifecycle status '${status}'.`);
    }
    return Object.freeze({
      target: parsedTarget,
      status: status as MemoryLifecycleDraft["status"],
      ...(candidate.replacement
        ? {
          replacement: parseRef(
            candidate.replacement,
            localIds,
            options,
            "Lifecycle replacement",
          ),
        }
        : {}),
      sources: parseSources(candidate.sources, options, "Lifecycle change"),
    });
  };
  const lifecycle = input.lifecycle === undefined
    ? Object.freeze([])
    : Array.isArray(input.lifecycle)
    ? Object.freeze(input.lifecycle.map(parseLifecycle))
    : (() => {
      throw new TypeError("Memory lifecycle changes must be an array.");
    })();

  const changed = entities.length + assertions.length + occurrences.length +
    intents.length + inquiries.length + procedures.length + relations.length +
    lifecycle.length;
  if (input.outcome === "no_changes" && changed) {
    throw new TypeError("A no_changes consolidation cannot contain changes.");
  }
  if (input.outcome === "changes" && !changed) {
    throw new TypeError(
      "A changes consolidation must contain at least one change.",
    );
  }
  return Object.freeze({
    outcome: input.outcome,
    ...(entities.length ? { entities } : {}),
    ...(assertions.length ? { assertions } : {}),
    ...(occurrences.length ? { occurrences } : {}),
    ...(intents.length ? { intents } : {}),
    ...(inquiries.length ? { inquiries } : {}),
    ...(procedures.length ? { procedures } : {}),
    ...(relations.length ? { relations } : {}),
    ...(lifecycle.length ? { lifecycle } : {}),
  });
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
    !selectedNewestFirst.length
  ) return null;
  const selected = selectedNewestFirst.reverse();
  const retainTarget = Math.max(0, input.retainRecentEstimatedTokens ?? 0);
  let retainedEstimatedTokens = 0;
  let retainedMessageCount = 0;
  if (retainTarget > 0) {
    const units: MemorySourceMessage[][] = [];
    for (const message of selected) {
      if (message.senderType === "tool" && units.length) {
        units.at(-1)!.push(message);
      } else units.push([message]);
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
    'Review the reserved history using your normal identity and instructions. Call consolidate_memory exactly once. If nothing durable changed, call it with {"outcome":"no_changes"}. Do not answer the user or continue the task.',
    "Extract only durable entities, assertions, meaningful occurrences, active intents, unresolved inquiries, and reusable procedures. Every record must be self-contained and cite allowed sources. Preserve uncertainty, negation, temporal meaning, authorship, and explicit corrections. Do not turn tentative language into facts, silently overwrite conflicts, create an entity for every noun, or persist small talk, raw tool output, token deltas, and transient wording. Use the default writable memory space unless another listed writable space clearly owns the record.",
    input.repair ? `Repair required: ${input.repair}` : "",
    "Allowed message evidence:",
    JSON.stringify(input.sourceMessages.map((message) => ({
      type: "message",
      id: message.id,
      senderType: message.senderType,
      senderId: message.senderId,
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
        ...(schema ? { attributesSchema: schema } : {}),
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
    ![
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
  return Object.freeze([
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
  ]);
}
