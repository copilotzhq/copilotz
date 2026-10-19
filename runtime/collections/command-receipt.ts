/** Owner-only binding for the atomic command underlying a worker transaction. */
import { createAsyncContextStorage } from "../../dependencies/async-hooks.ts";
import type { CommandJson, CommandRequest } from "../engine/commands.ts";
export type CollectionCommandReceipt = Readonly<{
  principal: string;
  receipt: NonNullable<CommandRequest<unknown>["receipt"]>;
  signal: AbortSignal;
}>;
const bindings = createAsyncContextStorage<CollectionCommandReceipt>();
export function collectionCommandReceipt():
  | CollectionCommandReceipt
  | undefined {
  return bindings.getStore();
}
export function withCollectionCommandReceipt<T>(
  binding: CollectionCommandReceipt,
  execute: () => Promise<T>,
): Promise<T> {
  return bindings.run(binding, execute);
}
export function capabilityReceiptIntent(bytes: Uint8Array): CommandJson {
  return JSON.parse(new TextDecoder().decode(bytes)) as CommandJson;
}
