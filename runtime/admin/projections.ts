import type { CopilotzApplication } from "../application/index.ts";
import type { ResolvedContent } from "../content/index.ts";
import type {
  CollectionRecord,
  ConversationMessage,
  ConversationThread,
  Participant,
} from "../domain/index.ts";
import type { DurableEvent } from "../events/index.ts";
import type { FeatureRequest } from "../features/index.ts";

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function queryText(
  request: FeatureRequest,
  name: string,
): string | undefined {
  const raw = request.query?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function queryTexts(
  request: FeatureRequest,
  name: string,
): readonly string[] | undefined {
  const raw = request.query?.[name];
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
    ? raw.split(",")
    : [];
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length
    ? Object.freeze([...new Set(normalized)])
    : undefined;
}

export function queryLimit(
  request: FeatureRequest,
  fallback = 50,
  maximum = 200,
): number {
  const raw = queryText(request, "limit");
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("limit must be a positive integer.");
  }
  return Math.min(value, maximum);
}

export function finite(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function optionalDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`Invalid date '${value}'.`);
  }
  return parsed;
}

export function inDateRange(
  value: string,
  from: Date | undefined,
  to: Date | undefined,
): boolean {
  const time = new Date(value).getTime();
  return (!from || time >= from.getTime()) && (!to || time <= to.getTime());
}

export async function allThreads(
  application: CopilotzApplication,
  namespace: string,
  options: {
    participantId?: string;
    status?: string | readonly string[];
    order?: "asc" | "desc";
  } = {},
): Promise<readonly ConversationThread[]> {
  const result: ConversationThread[] = [];
  let after: string | undefined;
  do {
    const page = await application.conversation.listThreads(namespace, {
      ...options,
      after,
      limit: 1_000,
    });
    result.push(...page);
    after = page.length === 1_000 ? page.at(-1)?.id : undefined;
  } while (after);
  return Object.freeze(result);
}

export async function allParticipants(
  application: CopilotzApplication,
  namespace: string,
): Promise<readonly Participant[]> {
  const result: Participant[] = [];
  let after: string | undefined;
  do {
    const page = await application.conversation.listParticipants(namespace, {
      after,
      limit: 1_000,
    });
    result.push(...page);
    after = page.length === 1_000 ? page.at(-1)?.id : undefined;
  } while (after);
  return Object.freeze(result);
}

export async function allMessages(
  application: CopilotzApplication,
  namespace: string,
  threadId: string,
): Promise<readonly ConversationMessage[]> {
  const result: ConversationMessage[] = [];
  let after: string | undefined;
  do {
    const page = await application.conversation.listMessages(
      namespace,
      threadId,
      { after, limit: 1_000 },
    );
    result.push(...page);
    after = page.length === 1_000 ? page.at(-1)?.id : undefined;
  } while (after);
  return Object.freeze(result);
}

export async function allEvents(
  application: CopilotzApplication,
  namespace: string,
  options: {
    threadId?: string;
    correlationId?: string;
    afterPosition?: string;
  } = {},
): Promise<readonly DurableEvent[]> {
  const result: DurableEvent[] = [];
  let afterPosition = options.afterPosition;
  do {
    const page = await application.events.list({
      namespace,
      threadId: options.threadId,
      correlationId: options.correlationId,
      afterPosition,
      limit: 1_000,
    });
    result.push(...page);
    afterPosition = page.length === 1_000 ? page.at(-1)?.position : undefined;
  } while (afterPosition);
  return Object.freeze(result);
}

export async function allCollectionRecords(
  application: CopilotzApplication,
  namespace: string,
  name: string,
  where?: Readonly<Record<string, unknown>>,
): Promise<readonly CollectionRecord[]> {
  if (!application.collections.names.includes(name)) return Object.freeze([]);
  const collection = application.collections.get(name);
  const result: CollectionRecord[] = [];
  let after: string | undefined;
  do {
    const page = await collection.list(namespace, {
      after,
      limit: 1_000,
      where,
    });
    result.push(...page);
    after = page.length === 1_000 ? page.at(-1)?.id : undefined;
  } while (after);
  return Object.freeze(result);
}

function resolvedText(value: ResolvedContent): string {
  if (typeof value.text === "string") return value.text;
  if (value.value !== undefined) {
    try {
      return JSON.stringify(value.value);
    } catch {
      return `[${value.ref.kind}]`;
    }
  }
  return `[${value.ref.kind}]`;
}

export async function messagePreview(
  application: CopilotzApplication,
  namespace: string,
  message: ConversationMessage | undefined,
  maximum = 280,
): Promise<string | null> {
  if (!message) return null;
  try {
    const resolved = await application.content.resolver.getMany(
      message.content,
      { namespace },
    );
    const text = resolved.map(resolvedText).join("\n").trim();
    return text ? text.slice(0, maximum) : null;
  } catch {
    return null;
  }
}

export function pageInfo<T extends { id: string }>(
  values: readonly T[],
  limit: number,
): Readonly<{ next?: string; hasMore: boolean }> {
  return values.length === limit
    ? Object.freeze({ next: values.at(-1)?.id, hasMore: true })
    : Object.freeze({ hasMore: false });
}
