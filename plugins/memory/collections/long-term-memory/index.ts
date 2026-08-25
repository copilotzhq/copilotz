/** Reserved and settled long-term-memory checkpoint collection definition. @module */
import {
  type CollectionDefinition,
  defineCollection,
} from "@copilotz/copilotz/collections";
import { longTermMemoryCollection as definition } from "../internal/definitions.ts";
export const longTermMemoryCollection: CollectionDefinition<
  typeof definition.schema
> = defineCollection({
  name: definition.name,
  schema: definition.schema,
  indexes: definition.indexes,
  relations: definition.relations,
  commands: definition.commands,
  content: definition.content,
});
