/**
 * Action Processor Middleware
 * ====================================================================
 * 
 * Middleware that processes actions using the new JSON Schema-based
 * action system. This converts legacy action modules to the new format.
 */

import { processActionsForAgent } from '../../actions/v2/index.ts';
import { legacyActionConverter } from '../../actions/v2/integration.ts';

/**
 * Detects if an action uses the old schema format
 * 
 * @param action - The action to check
 * @returns Whether the action uses the old schema format
 */
function isLegacyAction(action: any): boolean {
  // Check for properties specific to the old schema format
  return Boolean(action.specType) || 
         (action.spec && !action.inputSchema && !action.handler && !action.openAPISchema);
}

/**
 * Converts an action from the old schema format to the new schema format
 * 
 * @param action - The action in old format
 * @returns The action in new format
 */
async function convertActionFormat(action: any): Promise<any> {
  // For actions with specType (like openapi3_yaml), use the legacy converter
  if (action.specType) {
    try {
      // Special handling for OpenAPI schemas
      if (action.specType.toLowerCase().replace(/-/g, '_') === 'openapi3_yaml') {
        return {
          name: action.name || 'api',
          displayName: action.name || 'API',
          description: action.description || 'API Operations',
          // Keep the OpenAPI spec content intact
          openAPISchema: action.spec,
          _id: action._id,
          createdAt: action.createdAt,
          updatedAt: action.updatedAt
        };
      }
      
      // For other spec types, use the legacy converter
      const legacyParams = {
        specs: action.spec,
        specType: action.specType,
        module: action.moduleUrl || 'native:request',
        config: {
          name: action.name,
          description: action.description
        }
      };
      
      const convertedActions = await legacyActionConverter(legacyParams);
      if (convertedActions && convertedActions.length > 0) {
        const convertedAction = convertedActions[0];
        // Preserve original metadata
        convertedAction._id = action._id;
        convertedAction.createdAt = action.createdAt;
        convertedAction.updatedAt = action.updatedAt;
        return convertedAction;
      }
    } catch (error) {
      console.error(`Error converting legacy action ${action.name}:`, error);
      // Return a minimal valid action to prevent complete failure
      return {
        name: action.name || 'Unknown Action',
        description: action.description || 'Failed to convert legacy action',
        handler: async () => ({ error: 'Action conversion failed' })
      };
    }
  }
  
  // If it's not a specType action but still in legacy format,
  // do a more basic conversion (just moving properties around)
  return {
    name: action.name,
    description: action.description,
    handler: action.moduleUrl,
    spec: action.spec, // Preserve the spec if it exists
    _id: action._id,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt
  };
}

/**
 * Process actions using the new action system
 * 
 * @param req - The request object
 * @returns The processed request object
 */
async function processActions(this: any, req: any) {
  const context = this;
  
  // Get actions from the request
  const actions = req?.data?.resources?.copilotz?.actions || [];
  
  if (actions.length > 0) {
    try {
      // Create a new array to hold converted actions
      const processedActions = [];
      
      // Process each action
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        
        // Check if the action uses the old schema format
        if (isLegacyAction(action)) {
          // Convert from old format to new format
          const convertedAction = await convertActionFormat(action);
          processedActions.push(convertedAction);
        } else {
          // Already using new format, keep as is
          processedActions.push(action);
        }
      }
      
      // Replace the original actions with the processed ones
      req.data.resources.copilotz.actions = processedActions;
      
    } catch (error) {
      console.error('Error processing actions in middleware:', error);
      // Continue with original actions if there's an error
    }
  }
  
  return req;
}

export default processActions; 