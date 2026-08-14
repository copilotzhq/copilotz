export { createEventStoreError, isEventStoreError } from "./errors.ts";
export {
  createCopilotzEventHub,
  matchesCopilotzEvent,
  waitForCopilotzEvent,
} from "./hub.ts";
export type {
  CopilotzEventFilter,
  CopilotzEventHub,
  WaitForCopilotzEventOptions,
} from "./hub.ts";
export { createEventCoordinator } from "./coordinator.ts";
export type {
  CoordinatedMutationOptions,
  CoordinatedMutationResult,
  CreateEventCoordinatorOptions,
  EventCoordinator,
  EventDispatchReport,
  EventPublisher,
} from "./coordinator.ts";
export {
  createCoreSchemaStatements,
  createCoreTableNames,
  EVENT_SCHEMA_VERSION,
  provisionCopilotzSchema,
  quoteEventIdentifier,
  validateCopilotzSchema,
  validateEventSchemaName,
} from "./schema.ts";
export type { CoreSchemaValidation, CoreTableName } from "./schema.ts";
export { createSqlSession } from "./session.ts";
export type { SqlExecutor, SqlQueryResult, SqlSession } from "./session.ts";
export { createEventStore, serializeError } from "./store.ts";
export type {
  CommitEventMutationOptions,
  CommitEventMutationResult,
  CreateEventStoreOptions,
  EventMutationContext,
  EventStore,
} from "./store.ts";
export { createEphemeralEvent, isDurableEvent } from "./types.ts";
export type {
  CopilotzEvent,
  DeliveryScopeSettlement,
  DeliveryStatus,
  DurableEvent,
  DurableEventDraft,
  EphemeralEvent,
  EphemeralEventDraft,
  EventDelivery,
  EventRouting,
  EventStoreError,
  EventStoreErrorCode,
  EventSubject,
  EventVisibility,
} from "./types.ts";
