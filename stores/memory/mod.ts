/**
 * The in-memory store: everything in the process, gone when it ends. For
 * tests, demos and one-off runs. It's the runtime's own (what `durable: false`
 * collections live in), built on its query engine; here is where apps pick it,
 * beside the other stores.
 */
export { memoryStore } from "../../runtime/memory.ts";
