import type { EventCoordinator } from "../events/index.ts";
import type { DurableEvent, EventStore } from "../events/index.ts";
import {
  eventDataRef,
  readEventBody,
  writeEventBody,
} from "../events/body-store.ts";
import { withProcessorEventData } from "../plugins/processor.ts";
import { parseActionLifecycleEvent } from "./event.ts";
import {
  actionDefinitionById,
  actionDefinitionHasSecrets,
  hydrateActionLifecycleBody,
  prepareActionLifecycleBody,
  protectedActionLifecycleBody,
  publicActionLifecycleData,
  samePreparedActionLifecycleBody,
} from "./protected-lifecycle.ts";
import type { ProtectedValueRuntime } from "./protected-value.ts";
import type {
  ActionEventData,
  ActionLifecycleAppender,
  ActionLifecycleLoader,
  AnyActionDefinition,
} from "./types.ts";

type LifecycleStore = Pick<
  EventStore,
  "getEventByDeduplicationId" | "session" | "tables"
>;

type ActionLifecyclePersistenceOptions = Readonly<{
  store?: LifecycleStore;
  actions?: Readonly<Record<string, AnyActionDefinition>>;
  protectedValues?: ProtectedValueRuntime;
}>;

async function rawEventBody(
  store: Pick<EventStore, "session" | "tables">,
  event: DurableEvent,
): Promise<unknown> {
  return await readEventBody(
    { transaction: store.session, tables: store.tables },
    event.namespace,
    eventDataRef(event.payload),
  );
}

async function invokedInputRef(
  options: ActionLifecyclePersistenceOptions,
  namespace: string,
  data: ActionEventData,
) {
  if (data.status === "invoked" || !options.store) return undefined;
  const event = await options.store.getEventByDeduplicationId(
    namespace,
    `${data.actionRunId}:action:invoked`,
  );
  if (!event) {
    throw new Error(
      `Protected Action invoked receipt '${data.actionRunId}' is missing.`,
    );
  }
  const body = protectedActionLifecycleBody(
    await rawEventBody(options.store, event),
  );
  return body?.protected.input;
}

export function createActionLifecycleAppender(
  options:
    & Readonly<{ coordinator: EventCoordinator }>
    & ActionLifecyclePersistenceOptions,
): ActionLifecycleAppender {
  return async ({ draft, data }) => {
    const deduplicationId = draft.deduplicationId?.trim();
    if (!deduplicationId) {
      throw new TypeError("Action lifecycle events require deduplicationId.");
    }
    const action = options.actions
      ? actionDefinitionById(options.actions, data.actionId)
      : undefined;
    if (
      action && actionDefinitionHasSecrets(action) && !options.protectedValues
    ) {
      throw new Error(
        `Action '${action.id}' requires a configured Secret Adapter.`,
      );
    }
    if (action && actionDefinitionHasSecrets(action) && !options.store) {
      throw new Error("Protected Action lifecycle requires an Event Store.");
    }
    const prepared = action
      ? await prepareActionLifecycleBody({
        namespace: draft.namespace,
        data,
        action,
        protectedValues: options.protectedValues,
        existingInput: await invokedInputRef(
          options,
          draft.namespace,
          data,
        ),
      })
      : Object.freeze({
        body: data,
        publicData: data,
        prepared: Object.freeze([]),
      });
    const bodyId = `event-body:${draft.namespace}:${deduplicationId}`;
    const payload = {
      dataRef: {
        eventBodyId: bodyId,
        schemaVersion: 1,
        mediaType: "application/json" as const,
      },
    };
    return await options.coordinator.commitMutation({
      draft: { ...draft, payload },
      matchData: prepared.publicData,
      mutate: async (context) => {
        for (const value of prepared.prepared) {
          await options.protectedValues!.adopt(
            context,
            draft.namespace,
            value,
          );
        }
        await writeEventBody(context, {
          namespace: draft.namespace,
          id: payload.dataRef.eventBodyId,
          json: prepared.body,
        });
      },
      recoverDuplicate: async (event, context) => {
        const existing = await readEventBody(
          context,
          event.namespace,
          eventDataRef(event.payload),
        );
        if (!samePreparedActionLifecycleBody(existing, prepared.body)) {
          throw new Error(
            `Event body '${bodyId}' already exists with different content.`,
          );
        }
      },
    });
  };
}

export function createActionLifecycleLoader(
  options:
    & Readonly<{ store: LifecycleStore }>
    & Omit<ActionLifecyclePersistenceOptions, "store">,
): ActionLifecycleLoader {
  return async (namespaceInput, deduplicationId) => {
    const namespace = namespaceInput.trim();
    if (!namespace) throw new TypeError("Action namespace must be non-empty.");
    const id = deduplicationId.trim();
    if (!id) {
      throw new TypeError("Action event deduplication id must be non-empty.");
    }
    const event = await options.store.getEventByDeduplicationId(namespace, id);
    if (!event) return null;
    let raw: unknown;
    try {
      raw = await rawEventBody(options.store, event);
    } catch {
      throw new Error(
        `Event '${event.id}' at Action receipt identity '${id}' is not an authoritative Action lifecycle Event.`,
      );
    }
    const resolved = withProcessorEventData(
      event,
      publicActionLifecycleData(raw),
    );
    const lifecycle = parseActionLifecycleEvent(resolved);
    if (!lifecycle) {
      throw new Error(
        `Event '${event.id}' at Action receipt identity '${id}' is not an authoritative Action lifecycle Event.`,
      );
    }
    if (!options.actions) return lifecycle as ActionEventData;
    const action = actionDefinitionById(options.actions, lifecycle.actionId);
    return await hydrateActionLifecycleBody({
      namespace,
      body: raw as ActionEventData,
      action,
      protectedValues: options.protectedValues,
    });
  };
}
