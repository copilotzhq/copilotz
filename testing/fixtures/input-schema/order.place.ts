import type { Order as PlaceOrder } from "./contracts.ts";

// The generator reads the declaration without importing this module.
declare function defineAction<T>(action: T): T;
export default defineAction({
  run: async (_ctx: unknown, { lines }: PlaceOrder) => lines.length,
});
