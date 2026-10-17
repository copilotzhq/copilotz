/** Ordinary committed-state reads through the existing owner projection fence.
 * No receipt, cache, snapshot session or publication is created here. */
import { actionSchemaHasSecrets } from "../actions/secret.ts";
import { PROTECTED_VALUE_NODE_TYPE } from "../actions/protected-value.ts";
import { defineCollection } from "../collections/definition.ts";
import { sameValue } from "../collections/equal.ts";
import { queryCollectionRecords } from "../collections/query.ts";
import { aggregateCollectionRecords } from "../collections/aggregate.ts";
import type { CollectionFilter } from "../collections/types.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import {
  type OwnerCollectionReadRequest,
  parseOwnerCollectionReadRequest,
  parseOwnerCollectionReadScope,
} from "../execution/collection-read-call.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type {
  OwnerCaller,
  OwnerJson,
  OwnerProjectionHandler,
} from "./boundary.ts";
import type { OwnerChildActionBinding } from "./child-action.ts";
import { assertOwnerOrdinaryValue } from "./ordinary-value.ts";
import { OWNER_ORDINARY_SOURCE_SQL } from "./ordinary-source-sql.ts";
import {
  type OwnerAssignmentFacts,
  ownerAssignmentFacts,
} from "./attempt-authority.ts";

type ReadBindingFacts<B extends OwnerChildActionBinding> = B extends unknown
  ? Readonly<
    { kind: B["kind"]; assignment: OwnerAssignmentFacts<B["assignment"]> }
  >
  : never;
export type OwnerCollectionReadBinding = ReadBindingFacts<
  OwnerChildActionBinding
>;

function facts(binding: OwnerChildActionBinding): OwnerCollectionReadBinding {
  return {
    kind: binding.kind,
    assignment: ownerAssignmentFacts(binding.assignment),
  } as OwnerCollectionReadBinding;
}

export type OwnerCollectionReadPolicy = (
  tx: SqlExecutor,
  binding: OwnerCollectionReadBinding,
  request: OwnerCollectionReadRequest,
  time: string,
) => CollectionFilter | undefined | Promise<CollectionFilter | undefined>;

function refuse(): never {
  throw Object.assign(new Error("Collection read authority is unavailable."), {
    code: "ActionOwnershipLost",
  });
}

export function createOwnerCollectionRead(
  options: Readonly<{
    schema: string;
    registry: Pick<PluginRegistry, "collections">;
    resolve(
      tx: SqlExecutor,
      caller: OwnerCaller,
      time: string,
    ): Promise<OwnerChildActionBinding | undefined>;
    authorize?: OwnerCollectionReadPolicy;
  }>,
): OwnerProjectionHandler {
  const { resolve, authorize } = options;
  const tables = createCoreTableNames(options.schema);
  const budget = Object.freeze({
    maxRowBytes: 262_144,
    maxResultBytes: 1_048_576,
  });
  const collections = new Map(
    Object.entries(options.registry.collections)
      .filter(([, definition]) => {
        const schema = definition.schema;
        return definition.content === undefined &&
          !["asset", PROTECTED_VALUE_NODE_TYPE, "@copilotz/action-content"]
            .includes(definition.name) &&
          schema && typeof schema === "object" && !Array.isArray(schema) &&
          schema.type === "object" && !actionSchemaHasSecrets(schema);
      }).map(([alias, definition]) => [
        alias,
        defineCollection({
          name: definition.name,
          schema: structuredClone(definition.schema),
        }),
      ]),
  );
  return async (input, context) => {
    const request = parseOwnerCollectionReadRequest(input);
    const definition = collections.get(request.collectionAlias);
    if (!definition || !authorize) refuse();
    const { tx, commandTime: time, signal } = context;
    // Capture before any await; trusted policy receives detached data only.
    const caller = structuredClone(context.caller);
    const live = async () => {
      signal.throwIfAborted();
      const binding = await resolve(tx, structuredClone(caller), time);
      signal.throwIfAborted();
      if (!binding || binding.assignment.ctxGranted !== true) refuse();
      return structuredClone(binding);
    };
    const initial = await live();
    const scope = async () => {
      const decision = await authorize(
        tx,
        structuredClone(facts(initial)),
        structuredClone(request),
        time,
      );
      signal.throwIfAborted();
      if (decision === undefined) refuse();
      return parseOwnerCollectionReadScope(decision);
    };
    const permitted = await scope();
    if (!sameValue(facts(initial), facts(await live()))) refuse();
    const namespace = initial.assignment.namespace;
    const result = request.operation === "aggregate"
      ? await aggregateCollectionRecords(
        tx,
        tables,
        definition,
        namespace,
        {
          ...request.query,
          all: [...(request.query.all ?? []), permitted],
        },
        budget,
        OWNER_ORDINARY_SOURCE_SQL,
      )
      : await queryCollectionRecords(
        tx,
        tables,
        definition,
        namespace,
        request.operation === "get"
          ? { where: { id: request.id }, all: [permitted], limit: 1 }
          : {
            ...request.query,
            all: [...(request.query.all ?? []), permitted],
          },
        budget,
        OWNER_ORDINARY_SOURCE_SQL,
      );
    const finalScope = await scope();
    // This live recheck deliberately follows the last awaited policy callback.
    if (
      !sameValue(facts(initial), facts(await live())) ||
      !sameValue(permitted, finalScope)
    ) refuse();
    const output = request.operation === "get" ? result[0] ?? null : result;
    assertOwnerOrdinaryValue(output);
    if (
      new TextEncoder().encode(JSON.stringify(output)).length >
        budget.maxResultBytes
    ) {
      throw new RangeError("Collection read exceeds its output budget.");
    }
    return structuredClone(output) as OwnerJson;
  };
}
