/** Public semantic Server plugin and authoring surface. @module */

export { createServerPlugin, serverPlugin } from "./plugin.ts";
export * from "./authoring/index.ts";
export * from "./resources/index.ts";
export {
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  SERVER_ACTION_REQUEST_SCHEMA,
  type ServerEndpointDescriptor,
  type ServerHttpMethod,
} from "./internal/contracts.ts";
