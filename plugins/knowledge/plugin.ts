/** Public names for generated plugin composition. @module */
export { default as knowledgePlugin } from "./plugin.generated.ts";
export type KnowledgePlugin = typeof import("./plugin.generated.ts").default;
