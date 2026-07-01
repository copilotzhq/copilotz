import type {
  Event,
  EventProcessor,
  NewEvent,
  NewUnknownEvent,
  ProcessorDeps,
} from "@/types/index.ts";

export function coerceProcessorShouldProcess(
  fn: (event: unknown, deps?: unknown) => boolean | Promise<boolean>,
): EventProcessor<unknown, ProcessorDeps>["shouldProcess"] {
  return async (event: Event, deps: ProcessorDeps): Promise<boolean> => {
    try {
      return Boolean(await fn(event, deps));
    } catch {
      return false;
    }
  };
}

export function coerceProcessorProcess(
  fn: (event: unknown, deps?: unknown) => unknown | Promise<unknown>,
): EventProcessor<unknown, ProcessorDeps>["process"] {
  return async (event: Event, deps: ProcessorDeps) => {
    const result = await fn(event, deps);
    if (result == null) return;
    if (Array.isArray(result)) {
      return { producedEvents: result as Array<NewEvent | NewUnknownEvent> };
    }
    if (
      typeof result === "object" &&
      "type" in result &&
      "payload" in result
    ) {
      return { producedEvents: [result as NewEvent | NewUnknownEvent] };
    }
    if (
      typeof result === "object" &&
      "producedEvents" in result
    ) {
      const produced = (result as { producedEvents?: unknown }).producedEvents;
      if (Array.isArray(produced)) {
        return {
          producedEvents: produced as Array<NewEvent | NewUnknownEvent>,
        };
      }
      if (produced) {
        return { producedEvents: [produced as NewEvent | NewUnknownEvent] };
      }
    }
    if (
      typeof result === "object" &&
      "backgroundThreadIds" in result
    ) {
      const backgroundThreadIds =
        (result as { backgroundThreadIds?: unknown }).backgroundThreadIds;
      if (Array.isArray(backgroundThreadIds)) {
        return {
          backgroundThreadIds: backgroundThreadIds.filter(
            (value): value is string => typeof value === "string",
          ),
        };
      }
    }
    return;
  };
}
