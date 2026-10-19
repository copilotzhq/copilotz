/** Optional Core conversation HTTP integration. @module */
export { coreHttpPlugin } from "./plugin.ts";
export {
  coreHttpAdapter,
  type CoreHttpAdapterOptions,
  createCoreHttpAdapter,
  participantDisplayInputSchema,
  participantDisplayOutputSchema,
} from "./adapters/http/core/index.ts";
export * from "./adapters/http/core/operations/index.ts";
