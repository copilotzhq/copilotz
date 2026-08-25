/** Durable memory-space collection definition. @module */
import {
  type CollectionDefinition,
  defineCollection,
} from "@copilotz/copilotz/collections";
import { memorySpaceCollection as definition } from "../internal/definitions.ts";
export const memorySpaceCollection: CollectionDefinition<
  typeof definition.schema
> = defineCollection({
  name: definition.name,
  schema: definition.schema,
  indexes: definition.indexes,
  relations: definition.relations,
});
