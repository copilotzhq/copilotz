/**
 * New Actions System - Main Entry Point
 * ====================================================================
 * 
 * This provides a simplified, unified interface for action handling:
 * 
 * [{
 *   name: "actionName",
 *   displayName: "Human readable name",
 *   description: "Human readable description",
 *   inputSchema: { JSON schema for input },
 *   outputSchema: { JSON schema for output },
 *   handler: Function | URL,
 *   openAPISchema: URL | string,
 *   mcpServer: { config }
 * }]
 * 
 * - `handler` can be a function or URL (https or data URL)
 * - `openAPISchema` and `mcpServer` are optional alternatives to handler+schemas
 */

import actionHandler, { 
  processAction,
  jsonSchemaToFunctionSpec,
  jsonSchemaToShortSchema
} from './actionHandler.ts';

import type { 
  Action, 
  Actions,
  ActionArray,
  ActionContext,
  MCPServerConfig,
  ProcessedAction
} from './actionHandler.ts';

export {
  processAction,
  jsonSchemaToFunctionSpec,
  jsonSchemaToShortSchema
};

export type {
  Action,
  Actions,
  ActionArray,
  ActionContext,
  MCPServerConfig,
  ProcessedAction
};

export default actionHandler; 