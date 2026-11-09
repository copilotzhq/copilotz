/**
 * The agents theme's contracts, for plugins built on it, in Copilotz or
 * outside it (`copilotz/plugins/agents/contract`): each plugin's contract.ts,
 * the shapes of its documents and resource kinds and the little code that
 * goes with them (`tool()`, `agentsOf`, `SEND`…), and nothing else. Safe in
 * the browser; plugins reach the rest by name, through the runtime.
 */
export * from "./chat/contract.ts";
export * from "./skills/contract.ts";
export * from "./routines/contract.ts";
export * from "./openapi/contract.ts";
export * from "./webtools/contract.ts";
