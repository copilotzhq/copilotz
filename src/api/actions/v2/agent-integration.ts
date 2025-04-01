/**
 * Unified Agent Integration
 * ====================================================================
 * 
 * This file provides integration between the unified agent system
 * and the new action system. It converts action formats as needed
 * and ensures backward compatibility.
 */

import { Action, Actions, ActionContext } from './main.ts';
import actionHandler from './main.ts';
import { JsonSchema } from './jsonSchemaValidator.ts';

/**
 * Convert agent action modules to our action system format
 */
export function convertAgentModulesToActions(
  actionModules: Record<string, any>
): Action[] {
  const actions: Action[] = [];
  
  // Process each action module
  Object.entries(actionModules).forEach(([actionName, actionModule]) => {
    // Skip if actionModule is not a function
    if (typeof actionModule !== 'function') return;
    
    // Check if the module has a spec
    const spec = actionModule.spec;
    if (!spec) {
      // If no spec, create a minimal action
      actions.push({
        name: actionName,
        description: `Function ${actionName}`,
        handler: actionModule
      });
      return;
    }
    
    // Parse the spec to extract schemas
    const { inputSchema, outputSchema } = parseActionSpec(spec, actionName);
    
    // Create the action
    actions.push({
      name: actionName,
      displayName: extractName(spec) || actionName,
      description: extractDescription(spec) || `Function ${actionName}`,
      inputSchema,
      outputSchema,
      handler: actionModule
    });
  });
  
  return actions;
}

/**
 * Parse an action spec string into input/output schemas
 */
function parseActionSpec(
  spec: string, 
  actionName: string
): { inputSchema: JsonSchema; outputSchema: JsonSchema } {
  // Default schemas
  const inputSchema: JsonSchema = {
    type: 'object',
    properties: {},
    additionalProperties: true
  };
  
  const outputSchema: JsonSchema = {
    type: 'object',
    additionalProperties: true
  };
  
  try {
    // Extract function name/description
    const descriptionMatch = spec.match(/^\((.*?)\):/);
    if (descriptionMatch && descriptionMatch[1]) {
      inputSchema.description = descriptionMatch[1];
    }
    
    // Extract parameters
    const paramsMatch = spec.match(/:\s*(.*?)\s*->/);
    if (paramsMatch && paramsMatch[1]) {
      const params = paramsMatch[1].split(',').map(p => p.trim()).filter(p => p.length > 0);
      
      // Process each parameter
      params.forEach(param => {
        const isRequired = param.startsWith('!');
        const paramWithoutRequired = isRequired ? param.substring(1) : param;
        
        // Extract parameter name and type
        const paramMatch = paramWithoutRequired.match(/^([^<]+)(?:<([^>]+)>)?(?:\s*\(([^)]+)\))?/);
        
        if (paramMatch) {
          const [, paramName, paramType, paramDesc] = paramMatch;
          
          if (paramName) {
            // Add to properties
            inputSchema.properties![paramName] = {
              type: convertTypeToJsonSchemaType(paramType || 'any'),
              description: paramDesc
            };
            
            // Add to required list if necessary
            if (isRequired) {
              if (!inputSchema.required) {
                inputSchema.required = [];
              }
              inputSchema.required.push(paramName);
            }
          }
        }
      });
    }
    
    // Extract output description
    const outputMatch = spec.match(/->\s*\(?([^)]*)\)?$/);
    if (outputMatch && outputMatch[1]) {
      outputSchema.description = outputMatch[1];
    }
  } catch (error) {
    console.warn(`Error parsing spec for ${actionName}:`, error);
  }
  
  return { inputSchema, outputSchema };
}

/**
 * Extract name from spec string
 */
function extractName(spec: string): string | undefined {
  const match = spec.match(/^\((.*?)\):/);
  if (match && match[1]) {
    return match[1].split('(')[0].trim();
  }
  return undefined;
}

/**
 * Extract description from spec string
 */
function extractDescription(spec: string): string | undefined {
  const match = spec.match(/^\((.*?)\):/);
  if (match && match[1]) {
    // Check if there's a description in parentheses
    const descMatch = match[1].match(/\((.*?)\)/);
    return descMatch ? descMatch[1] : match[1];
  }
  return undefined;
}

/**
 * Convert simple type string to JSON Schema type
 */
function convertTypeToJsonSchemaType(type: string): string | string[] {
  switch (type.toLowerCase()) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'object':
    case 'array':
    case 'null':
      return type.toLowerCase();
    case 'integer':
      return 'integer';
    case 'date':
      return 'string'; // date-time format
    case 'any':
      return ['string', 'number', 'boolean', 'object', 'array', 'null'];
    default:
      return 'string';
  }
}

/**
 * Function to process actions for the agent
 * This can be used directly by the unified agent
 */
export async function processActionsForAgent(
  context: ActionContext,
  actionModules: Record<string, any>
): Promise<Record<string, any>> {
  try {
    // 1. Convert agent modules to our action format
    const actions = convertAgentModulesToActions(actionModules);
    
    // 2. Process actions with our action handler
    const processedActions = await actionHandler.bind(context)(actions);
    
    // 3. Return the processed actions
    return processedActions;
  } catch (error) {
    console.error('Error processing actions for agent:', error);
    // Return original modules as fallback
    return actionModules;
  }
}

export default processActionsForAgent; 