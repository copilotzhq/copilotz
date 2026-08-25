/** Semantic-memory record collection definition. @module */
import {
  type CollectionDefinition,
  defineCollection,
} from "@copilotz/copilotz/collections";
import { memoryRecordCollection as definition } from "../internal/definitions.ts";
export const memoryRecordCollection: CollectionDefinition<
  typeof definition.schema
> = defineCollection({
  name: definition.name,
  schema: definition.schema,
  indexes: definition.indexes,
  relations: definition.relations,
  search: definition.search,
  content: definition.content,
});
