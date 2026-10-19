import { createMemoryBodyStore } from "./body-store.ts";
import { bodyStoreConformance } from "../testing/body-store-conformance.ts";
Deno.test("memory BodyStore physical conformance", async (t) => {
  await bodyStoreConformance(t, createMemoryBodyStore());
});
