/**
 * Copilotz Action System
 * ====================================================================
 * 
 * This is the main entry point for the action system.
 * It provides both the new unified interface and backward compatibility.
 * 
 * The new system allows actions to be defined in a simple, declarative way:
 * 
 * {
 *   [actionName]: {
 *     name: "Human readable name",
 *     description: "Human readable description",
 *     inputSchema: { JSON schema for input },
 *     outputSchema: { JSON schema for output },
 *     handler: Function | URL,
 *     openAPISchema: URL | string,
 *     mcpServer: { config }
 *   }
 * }
 */

// New unified action system
import actionHandler, {
  processAction,
  jsonSchemaToFunctionSpec,
  jsonSchemaToShortSchema
} from './main.ts';

import type {
  Action,
  Actions,
  ActionContext,
  MCPServerConfig,
  ProcessedAction
} from './main.ts';

// Legacy compatibility layer
import legacyActionExecutor, {
  legacyActionConverter
} from './integration.ts';

// Agent integration
import processActionsForAgent, {
  convertAgentModulesToActions
} from './agent-integration.ts';

// Examples
import { exampleActions, demonstrateActions, snippets } from './examples.ts';

// Export new, unified API
export {
  // Main handler
  actionHandler,
  
  // Utility functions
  processAction,
  jsonSchemaToFunctionSpec,
  jsonSchemaToShortSchema,
  
  // Legacy compatibility
  legacyActionExecutor,
  legacyActionConverter,
  
  // Agent integration
  processActionsForAgent,
  convertAgentModulesToActions,
  
  // Examples
  exampleActions,
  demonstrateActions,
  snippets
};

// Export type definitions
export type {
  // Types and interfaces
  Action,
  Actions,
  ActionContext,
  MCPServerConfig,
  ProcessedAction
};

// For backward compatibility with existing code
export default legacyActionExecutor; 