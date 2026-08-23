import type { EventCoordinator } from "../events/index.ts";
import type { EventStore } from "../events/index.ts";
import { writeEventBody } from "../events/body-store.ts";
import { resolveProcessorEvent } from "../plugins/event-data.ts";
import { parseActionLifecycleEvent } from "./event.ts";
import type {
  ActionEventData,
  ActionLifecycleAppender,
  ActionLifecycleLoader,
} from "./types.ts";

export function createActionLifecycleAppender(
  options: Readonly<{ coordinator: EventCoordinator }>,
): ActionLifecycleAppender {
  return async ({ draft, data }) => {
    const deduplicationId = draft.deduplicationId?.trim();
    if (!deduplicationId) {
      throw new TypeError("Action lifecycle events require deduplicationId.");
    }
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
      matchData: data,
      mutate: async (context) => {
        await writeEventBody(context, {
          namespace: draft.namespace,
          id: payload.dataRef.eventBodyId,
          json: data,
        });
      },
      recoverDuplicate: async (event, context) => {
        await writeEventBody(context, {
          namespace: event.namespace,
          id: payload.dataRef.eventBodyId,
          json: data,
        });
      },
    });
  };
}

export function createActionLifecycleLoader(
  options: Readonly<{
    store: Pick<
      EventStore,
      "getEventByDeduplicationId" | "session" | "tables"
    >;
  }>,
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
    const resolved = await resolveProcessorEvent(
      options.store,
      event,
    );
    const lifecycle = parseActionLifecycleEvent(resolved);
    if (!lifecycle) {
      throw new Error(
        `Event '${event.id}' at Action receipt identity '${id}' is not an authoritative Action lifecycle Event.`,
      );
    }
    return lifecycle as ActionEventData;
  };
}
