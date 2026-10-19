/** Native owner authorization fixture for Collection queue/fencing tests. */
import {
  collectionAuthorizations,
  type OwnerPolicy,
} from "../authorization/evaluator.ts";
import type { CollectionDefinition } from "../collections/definition.ts";
export function testCollectionAuthorizations(
  definitions: Readonly<Record<string, CollectionDefinition>>,
  schema: string,
  evaluate: OwnerPolicy["evaluate"],
) {
  return collectionAuthorizations(
    {
      policies: {
        fixture: { revision: "1", sources: Object.keys(definitions), evaluate },
      },
      collections: Object.fromEntries(
        Object.keys(definitions).map((
          alias,
        ) => [alias, { id: "fixture", revision: "1" }]),
      ),
      actions: {},
    },
    definitions,
    schema,
  );
}
