import { eventDataRef, readEventBody } from "../events/body-store.ts";
import type { CopilotzEvent, EventStore } from "../events/index.ts";
import { matchDataFromPayload } from "./match.ts";
import { type ProcessorEvent, withProcessorEventData } from "./processor.ts";

export async function resolveProcessorEventData(
  store: Pick<EventStore, "session" | "tables">,
  event: CopilotzEvent,
): Promise<unknown> {
  if (!event.durable) return event.payload;
  const fromPayload = matchDataFromPayload(event.payload);
  if (fromPayload !== undefined) return fromPayload;
  return await readEventBody(
    { transaction: store.session, tables: store.tables },
    event.namespace,
    eventDataRef(event.payload),
  );
}

export async function resolveProcessorEvent(
  store: Pick<EventStore, "session" | "tables">,
  event: CopilotzEvent,
): Promise<ProcessorEvent> {
  return withProcessorEventData(
    event,
    await resolveProcessorEventData(store, event),
  );
}
