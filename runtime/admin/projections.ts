import type { ResolvedContent } from "../content/index.ts";
import type { CollectionRecord } from "../collections/index.ts";
import type { ActionContext } from "../actions/index.ts";
import type { AdminRequest } from "./types.ts";

type AdminQueryContext = ActionContext;

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function queryText(
  request: AdminRequest,
  name: string,
): string | undefined {
  const raw = request.query?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function queryTexts(
  request: AdminRequest,
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
  request: AdminRequest,
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
  context: AdminQueryContext,
  options: {
    participantId?: string;
    status?: string | readonly string[];
    order?: "asc" | "desc";
  } = {},
): Promise<readonly CollectionRecord[]> {
  let values = [...await allCollectionRecords(context, "thread")];
  if (options.participantId) {
    values = values.filter((thread) =>
      Array.isArray(thread.participantIds) &&
      thread.participantIds.includes(options.participantId)
    );
  }
  if (options.status) {
    const statuses = typeof options.status === "string"
      ? [options.status]
      : options.status;
    values = values.filter((thread) =>
      statuses.includes(String(thread.status))
    );
  }
  const direction = options.order === "asc" ? 1 : -1;
  values.sort((left, right) =>
    direction *
    String(left.lastEventAt ?? left.updatedAt).localeCompare(
      String(right.lastEventAt ?? right.updatedAt),
    )
  );
  return Object.freeze(values);
}

export async function allParticipants(
  context: AdminQueryContext,
): Promise<readonly CollectionRecord[]> {
  return await allCollectionRecords(context, "participant");
}

export async function allMessages(
  context: AdminQueryContext,
  threadId: string,
): Promise<readonly CollectionRecord[]> {
  return await allCollectionRecords(context, "message", { threadId });
}

export async function allCollectionRecords(
  context: AdminQueryContext,
  name: string,
  where?: Readonly<Record<string, unknown>>,
): Promise<readonly CollectionRecord[]> {
  const collection = context.collections[name];
  if (!collection) return Object.freeze([]);
  const result: CollectionRecord[] = [];
  let after: string | undefined;
  do {
    const page = await collection.list({
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
  context: AdminQueryContext,
  message: CollectionRecord | undefined,
  maximum = 280,
): Promise<string | null> {
  if (!message) return null;
  try {
    const content = Array.isArray(message.content) ? message.content : [];
    const resolved = await context.content.resolveMany(
      content as Parameters<ActionContext["content"]["resolveMany"]>[0],
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
