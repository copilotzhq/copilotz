import { eventDataRef, readEventBody } from "../events/body-store.ts";
import { cloneContentRef } from "../content/input.ts";
import { isContentRef } from "../content/schema.ts";
import type { ContentRef, ContentResolver } from "../content/index.ts";
import type { CopilotzEvent, EventStore } from "../events/index.ts";
import { publicActionLifecycleData } from "../actions/protected-lifecycle.ts";
import { publicProtectedEventData } from "../actions/protected-event.ts";
import { matchDataFromPayload } from "./match.ts";
import { type ProcessorEvent, withProcessorEventData } from "./processor.ts";

type ContentResolutionTarget = Record<string, unknown>;

function sameResolvedReference(
  expected: ContentRef,
  actual: ContentRef | undefined,
): boolean {
  return actual?.assetId === expected.assetId &&
    actual.kind === expected.kind && actual.role === expected.role &&
    actual.mediaType === expected.mediaType;
}

/**
 * Resolves text and JSON ContentRefs anywhere in Event data without changing
 * the canonical reference metadata. Binary refs remain metadata-only so Event
 * delivery does not embed arbitrary body bytes.
 */
export async function hydrateProcessorEventContent(
  data: unknown,
  resolver: Pick<ContentResolver, "getMany">,
  namespace: string,
): Promise<unknown> {
  const refs: ContentRef[] = [];
  const targets: ContentResolutionTarget[] = [];
  const visit = (value: unknown): unknown => {
    if (isContentRef(value)) {
      const ref = cloneContentRef(value);
      const descriptorOnly = (value as { resolve?: unknown }).resolve === false;
      const resolved = {
        ...ref,
        ...(ref.metadata
          ? { metadata: visit(ref.metadata) as Record<string, unknown> }
          : {}),
        ...(descriptorOnly ? { resolve: false } : {}),
      };
      if (!descriptorOnly && (ref.kind === "text" || ref.kind === "json")) {
        refs.push(resolved);
        targets.push(resolved);
      }
      return resolved;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return structuredClone(value);
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, visit(child)]),
      );
    }
    return value;
  };

  const hydrated = visit(data);
  if (!refs.length) return hydrated;
  const resolved = await resolver.getMany(refs, { namespace });
  if (resolved.length !== refs.length) {
    throw new Error(
      "Content resolver returned an incomplete Event data batch.",
    );
  }
  for (const [index, item] of resolved.entries()) {
    const ref = refs[index];
    if (!sameResolvedReference(ref, item?.ref)) {
      throw new Error(
        "Content resolver returned the wrong Event data reference.",
      );
    }
    if (ref.kind === "text") {
      if (typeof item.text !== "string") {
        throw new Error("Content resolver returned invalid text Event data.");
      }
      targets[index].value = item.text;
    } else {
      if (item.value === undefined) {
        throw new Error("Content resolver returned invalid JSON Event data.");
      }
      targets[index].value = item.value;
    }
  }
  return hydrated;
}

const RESOLVED_EVENT_LIMIT = 256;
const RESOLVED_EVENT_TTL_MS = 30_000;
type ResolvedEventEntry = { at: number; data: Promise<unknown> };
const resolvedEvents = new WeakMap<object, Map<string, ResolvedEventEntry>>();

/**
 * An Event and the content its data references are immutable, and one Event is
 * resolved several times as it moves through publish, live matching and its
 * delivery. Resolve it once per scope for a short window instead. Every caller
 * still receives its own copy, and a failed resolution is never remembered.
 */
async function resolveOnce(
  scope: object,
  event: CopilotzEvent & { durable: true },
  resolve: () => Promise<unknown>,
): Promise<unknown> {
  let entries = resolvedEvents.get(scope);
  if (!entries) resolvedEvents.set(scope, entries = new Map());
  const now = Date.now();
  let entry = entries.get(event.id);
  if (!entry || now - entry.at > RESOLVED_EVENT_TTL_MS) {
    const created: ResolvedEventEntry = { at: now, data: resolve() };
    entries.delete(event.id);
    entries.set(event.id, entry = created);
    if (entries.size > RESOLVED_EVENT_LIMIT) {
      entries.delete(entries.keys().next().value!);
    }
    created.data.catch(() => {
      if (entries!.get(event.id) === created) entries!.delete(event.id);
    });
  }
  return structuredClone(await entry.data);
}

export function resolveProcessorEventData(
  store:
    & Pick<EventStore, "session" | "tables">
    & Partial<Pick<EventStore, "recentEventBody">>,
  event: CopilotzEvent,
  resolver?: Pick<ContentResolver, "getMany">,
): Promise<unknown> {
  return resolver && event.durable
    ? resolveOnce(
      store.tables,
      event,
      () => loadProcessorEventData(store, event, resolver),
    )
    : loadProcessorEventData(store, event, resolver);
}

async function loadProcessorEventData(
  store:
    & Pick<EventStore, "session" | "tables">
    & Partial<Pick<EventStore, "recentEventBody">>,
  event: CopilotzEvent,
  resolver?: Pick<ContentResolver, "getMany">,
): Promise<unknown> {
  let data: unknown;
  if (!event.durable) {
    data = event.payload;
  } else {
    const fromPayload = matchDataFromPayload(event.payload);
    const ref = fromPayload === undefined
      ? eventDataRef(event.payload)
      : undefined;
    data = ref === undefined ? fromPayload : publicProtectedEventData(
      publicActionLifecycleData(
        store.recentEventBody?.(event.id, ref.eventBodyId)?.json ??
          await readEventBody(
            { transaction: store.session, tables: store.tables },
            event.namespace,
            ref,
          ),
      ),
    );
  }
  return resolver
    ? await hydrateProcessorEventContent(data, resolver, event.namespace)
    : data;
}

export async function resolveProcessorEvent(
  store:
    & Pick<EventStore, "session" | "tables">
    & Partial<Pick<EventStore, "recentEventBody">>,
  event: CopilotzEvent,
  resolver?: Pick<ContentResolver, "getMany">,
): Promise<ProcessorEvent> {
  return withProcessorEventData(
    event,
    await resolveProcessorEventData(store, event, resolver),
  );
}
