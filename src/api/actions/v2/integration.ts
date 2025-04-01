/**
 * Action System V2 Integration
 * ====================================================================
 * 
 * This file provides compatibility with the old action system while
 * using the new unified approach internally.
 */

import YAML from "npm:yaml";
import actionHandler from './main.ts';
import type { Action, Actions } from './main.ts';

/**
 * Legacy action format - old-style action executor parameters
 */
interface LegacyActionParams {
  specs: string;            // Spec content
  specType: string;         // Spec type (openapi3-yaml, json-schema, short-schema)
  module: string;           // Module URL or name
  config?: Record<string, any>; // Configuration
  [key: string]: any;       // Additional properties
}

/**
 * Converter for legacy action format
 */
async function legacyActionConverter(
  { specs, specType, module, config = {} }: LegacyActionParams
): Promise<Action[]> {
  // Create a suitable action object for the new system
  const actions: Action[] = [];
  
  switch (specType.toLowerCase().replace(/-/g, '_')) {
    case 'openapi3_yaml':
      // Handle OpenAPI specification
      const actionName = config.name || 'api';
      actions.push({
        name: actionName,
        displayName: config.name || 'API',
        description: config.description || 'API Operations',
        openAPISchema: specs
      });
      break;
      
    case 'json_schema':
      // Handle JSON Schema
      if (!config.name) {
        throw new Error('JSON Schema actions require a name in config');
      }
      
      let jsonSchema: any;
      try {
        jsonSchema = typeof specs === 'string' ? JSON.parse(specs) : specs;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSON Schema: ${errorMessage}`);
      }
      
      // Create an action with the JSON schema
      actions.push({
        name: config.name,
        displayName: config.name,
        description: jsonSchema.description || config.description || config.name,
        inputSchema: jsonSchema,
        outputSchema: config.outputSchema || { 
          type: 'object', 
          properties: {},
          additionalProperties: true
        },
        // Handler will be determined by the module parameter
        handler: module.startsWith('native:') 
          ? `data:text/javascript;charset=utf-8,${createNativeModuleHandler(module.replace('native:', ''))}`
          : module
      });
      break;
      
    case 'short_schema':
      // Handle Short Schema - convert to JSON Schema first
      if (!config.name) {
        throw new Error('Short Schema actions require a name in config');
      }
      
      // Conversion logic would go here
      // For now, we'll throw an error
      throw new Error('Short Schema conversion not implemented yet');
      
    default:
      throw new Error(`Unsupported legacy spec type: ${specType}`);
  }
  
  return actions;
}

/**
 * Create a handler for native modules
 */
function createNativeModuleHandler(moduleName: string): string {
  // This creates a small module that will dynamically import the native module
  return `
    export default async function(params) {
      const module = await import('/src/api/actions/modules/${moduleName}/main.js');
      return module.default(params);
    }
  `;
}

/**
 * Legacy-compatible action executor function
 */
async function legacyActionExecutor(
  this: any,
  params: LegacyActionParams
): Promise<Record<string, Function>> {
  const context = this;
  
  try {
    // Convert legacy format to new action format
    const actions = await legacyActionConverter(params);
    
    // Process actions with the new handler
    const processedActions = await actionHandler.bind(context)(actions);
    
    return processedActions;
  } catch (error) {
    console.error('Error in legacy action executor:', error);
    throw error;
  }
}

export {
  legacyActionExecutor,
  legacyActionConverter
};

export default legacyActionExecutor; 