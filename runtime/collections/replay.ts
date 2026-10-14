import type { DurableEvent } from "../events/index.ts";
import type { CollectionDefinition } from "./definition.ts";

function collectionEventNames(
  definition: CollectionDefinition,
): ReadonlySet<string> {
  return new Set([
    `${definition.name}.created`,
    `${definition.name}.updated`,
    `${definition.name}.deleted`,
    ...Object.values(definition.commands ?? {}).flatMap((command) =>
      command.event ? [command.event] : []
    ),
  ]);
}

export function isCollectionEvent(
  event: DurableEvent,
  collection: string | CollectionDefinition,
): boolean {
  if (typeof collection === "string") {
    return event.type === `${collection}.created` ||
      event.type === `${collection}.updated` ||
      event.type === `${collection}.deleted`;
  }
  return collectionEventNames(collection).has(event.type);
}
