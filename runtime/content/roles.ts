import type {
  ContentRef,
  ContentSequence,
  DurableContentInput,
  PreparedAsset,
  PreparedContent,
} from "./types.ts";
import { cloneContentRef } from "./input.ts";

export const TOOL_CONTENT_ROLE: Readonly<{
  arguments: "tool.arguments";
  output: "tool.output";
  projectedOutput: "tool.projected_output";
  errorDetail: "tool.error_detail";
}> = Object.freeze(
  {
    arguments: "tool.arguments",
    output: "tool.output",
    projectedOutput: "tool.projected_output",
    errorDetail: "tool.error_detail",
  } as const,
);

export const LLM_CONTENT_ROLE: Readonly<{
  input: "llm.input";
  toolDefinitions: "llm.tool_definitions";
  answer: "body";
  reasoning: "reasoning";
  toolCalls: "llm.tool_calls";
  errorDetail: "provider.error_detail";
  trace: "provider.trace";
}> = Object.freeze(
  {
    input: "llm.input",
    toolDefinitions: "llm.tool_definitions",
    answer: "body",
    reasoning: "reasoning",
    toolCalls: "llm.tool_calls",
    errorDetail: "provider.error_detail",
    trace: "provider.trace",
  } as const,
);

export type RoleContentInput = Readonly<{
  role: string;
  input: DurableContentInput;
  cardinality?: "one" | "many";
}>;

export type RoleContentOwner = Readonly<{
  id?: string;
  content?: unknown;
}>;

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

function isSequence(value: DurableContentInput): value is ContentSequence {
  return Array.isArray(value);
}

function asPrepared(value: DurableContentInput): PreparedContent {
  return isSequence(value) ? { content: value, assets: [] } : value;
}

export function contentSequence(value: unknown): ContentSequence {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value) as ContentSequence;
}

/** Combines independently prepared fields into one transaction batch. */
export function composeRoleContent(
  fields: readonly RoleContentInput[],
): PreparedContent {
  const content: ContentRef[] = [];
  const assets = new Map<string, PreparedAsset>();
  for (const field of fields) {
    const prepared = asPrepared(field.input);
    if (field.cardinality === "one" && prepared.content.length !== 1) {
      throw new TypeError(`${field.role} requires exactly one content ref.`);
    }
    for (const ref of prepared.content) {
      content.push(cloneContentRef({ ...ref, role: field.role }));
    }
    for (const asset of prepared.assets) {
      const existing = assets.get(asset.id);
      if (
        existing && canonicalJson({
            namespace: existing.namespace,
            mediaType: existing.mediaType,
            byteLength: existing.byteLength,
            digest: existing.digest,
            idempotencyKey: existing.idempotencyKey,
          }) !== canonicalJson({
            namespace: asset.namespace,
            mediaType: asset.mediaType,
            byteLength: asset.byteLength,
            digest: asset.digest,
            idempotencyKey: asset.idempotencyKey,
          })
      ) {
        throw new TypeError(`Prepared asset '${asset.id}' is inconsistent.`);
      }
      if (!existing) assets.set(asset.id, asset);
    }
  }
  return Object.freeze({
    content: Object.freeze(content),
    assets: Object.freeze([...assets.values()]),
  });
}

export function replaceContentRoles(
  current: ContentSequence,
  replacement: ContentSequence,
  roles: ReadonlySet<string>,
): ContentSequence {
  return Object.freeze([
    ...current.filter((ref) => !roles.has(ref.role)).map(cloneContentRef),
    ...replacement.map(cloneContentRef),
  ]);
}

export function contentWithRole(
  content: ContentSequence,
  role: string,
): ContentSequence {
  return Object.freeze(
    content.filter((ref) => ref.role === role).map(cloneContentRef),
  );
}

export function firstContentWithRole(
  content: ContentSequence,
  role: string,
): ContentRef | undefined {
  const ref = content.find((candidate) => candidate.role === role);
  return ref ? cloneContentRef(ref) : undefined;
}

export function assertRoleContentMatches(
  actual: ContentSequence,
  expected: ContentSequence,
  roles: ReadonlySet<string>,
  label: string,
): void {
  const select = (value: ContentSequence) =>
    value.filter((ref) => roles.has(ref.role));
  if (canonicalJson(select(actual)) !== canonicalJson(select(expected))) {
    throw new Error(
      `${label} deduplication identity was reused with different content.`,
    );
  }
}

export function toolExecutionContent(execution: RoleContentOwner): Readonly<{
  arguments: ContentRef;
  output?: ContentRef;
  projectedOutput?: ContentRef;
  errorDetail?: ContentRef;
  attachments: ContentSequence;
}> {
  const content = contentSequence(execution.content);
  const first = (role: string) => content.find((ref) => ref.role === role);
  const argumentsRef = first(TOOL_CONTENT_ROLE.arguments);
  if (!argumentsRef) {
    throw new Error(
      `Tool execution '${execution.id ?? "unknown"}' has no arguments.`,
    );
  }
  const reserved = new Set<string>(Object.values(TOOL_CONTENT_ROLE));
  return Object.freeze({
    arguments: argumentsRef,
    ...(first(TOOL_CONTENT_ROLE.output)
      ? { output: first(TOOL_CONTENT_ROLE.output) }
      : {}),
    ...(first(TOOL_CONTENT_ROLE.projectedOutput)
      ? { projectedOutput: first(TOOL_CONTENT_ROLE.projectedOutput) }
      : {}),
    ...(first(TOOL_CONTENT_ROLE.errorDetail)
      ? { errorDetail: first(TOOL_CONTENT_ROLE.errorDetail) }
      : {}),
    attachments: Object.freeze(
      content.filter((ref) => !reserved.has(ref.role)),
    ),
  });
}

export function llmAttemptContent(attempt: RoleContentOwner): Readonly<{
  input: ContentSequence;
  toolDefinitions?: ContentRef;
  answer?: ContentRef;
  reasoning?: ContentRef;
  toolCalls?: ContentRef;
  errorDetail?: ContentRef;
  trace?: ContentRef;
}> {
  const content = contentSequence(attempt.content);
  const first = (role: string) => content.find((ref) => ref.role === role);
  const input = Object.freeze(
    content.filter((ref) => ref.role === LLM_CONTENT_ROLE.input),
  );
  const toolDefinitions = first(LLM_CONTENT_ROLE.toolDefinitions);
  const answer = first(LLM_CONTENT_ROLE.answer);
  const reasoning = first(LLM_CONTENT_ROLE.reasoning);
  const toolCalls = first(LLM_CONTENT_ROLE.toolCalls);
  const errorDetail = first(LLM_CONTENT_ROLE.errorDetail);
  const trace = first(LLM_CONTENT_ROLE.trace);
  return Object.freeze({
    input,
    ...(toolDefinitions ? { toolDefinitions } : {}),
    ...(answer ? { answer } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(errorDetail ? { errorDetail } : {}),
    ...(trace ? { trace } : {}),
  });
}
