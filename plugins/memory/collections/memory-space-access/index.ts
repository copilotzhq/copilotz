/** Thread-to-memory-space access collection definition. @module */
import {
  type CollectionDefinition,
  defineCollection,
} from "@copilotz/copilotz/collections";
import { memorySpaceAccessCollection as definition } from "../internal/definitions.ts";
export const memorySpaceAccessCollection: CollectionDefinition<
  typeof definition.schema
> = defineCollection({
  name: definition.name,
  schema: definition.schema,
  indexes: definition.indexes,
  relations: definition.relations,
});
