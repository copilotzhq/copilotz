/** Applies one admitted Server collection mutation with durable retry identity. @module */

import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "@copilotz/copilotz/plugins";
import type { RuntimeContextNamespaces } from "@copilotz/copilotz/actions";
import {
  parseServerCollectionMutationRequest,
  SERVER_COLLECTION_MUTATION_METADATA_SCHEMA,
  SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE,
  type ServerCollectionMutationRequest,
} from "../../shared/contracts.ts";

type ServerCollectionProcessorContext = ProcessorContext<
  RuntimeContextNamespaces,
  RuntimeContextNamespaces
>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export const serverCollectionMutationRequestProcessor: Processor<
  ServerCollectionProcessorContext
> = defineProcessor({
  id: "copilotz.server.collection-mutation-request",
  on: [{ eventType: SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE }],
  async handle(event, context) {
    if (!event.durable) {
      throw new TypeError(
        "Server collection mutation requests must be durable Events.",
      );
    }
    const request = parseServerCollectionMutationRequest(event.data);
    const collection = context.collections[request.collectionAlias];
    if (!collection) {
      throw new TypeError(
        `Server collection '${request.collectionAlias}' is unavailable.`,
      );
    }
    const identity = context.identity;
    const options = {
      operationKey: `server:${request.requestId}:mutation`,
      identity,
      metadata: {
        copilotzServer: {
          schema: SERVER_COLLECTION_MUTATION_METADATA_SCHEMA,
          requestId: request.requestId,
          collectionAlias: request.collectionAlias,
          operation: request.operation,
          ...(request.command ? { command: request.command } : {}),
        },
      },
      ...(request.condition ? { condition: request.condition } : {}),
    } as const;
    if (request.operation === "create") {
      await collection.create(record(request.input), options);
      return;
    }
    const id = request.id!;
    if (request.operation === "update") {
      const patch = record(request.input);
      await collection.update({
        id,
        ...(patch.set !== undefined ? { set: record(patch.set) } : {}),
        ...(Array.isArray(patch.unset)
          ? { unset: [...patch.unset] as string[] }
          : {}),
      }, options);
      return;
    }
    if (request.operation === "delete") {
      await collection.delete({ id }, options);
      return;
    }
    const command = request.command!;
    const commandInput = record(request.input);
    const commandRunner = collection.commands[command];
    if (!commandRunner) {
      throw new TypeError(
        `Server collection command '${request.collectionAlias}.${command}' is unavailable.`,
      );
    }
    await commandRunner({ ...commandInput, id }, options);
  },
});

export default serverCollectionMutationRequestProcessor;

export type { ServerCollectionMutationRequest };
