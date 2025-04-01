// actionHandler.ts
// New unified action handler for Copilotz
// ============================================================

import YAML from "npm:yaml";
import { jsonrepair } from "npm:jsonrepair";
import { validate, JsonSchema } from './jsonSchemaValidator.ts';

// ============================================================
// TYPES
// ============================================================

/**
 * Action definition interface
 */
export interface Action {
  name?: string;               // Human readable name
  description?: string;        // Human readable description
  inputSchema?: JsonSchema;    // JSON schema for input validation
  outputSchema?: JsonSchema;   // JSON schema for output validation
  handler?: Function | string; // Function or URL to handle the action
  openAPISchema?: string;      // OpenAPI schema URL or content
  mcpServer?: MCPServerConfig; // MCP server configuration
  [key: string]: any;          // Additional properties
}

/**
 * MCP Server configuration 
 */
export interface MCPServerConfig {
  url: string;
  headers?: Record<string, string>;
  options?: Record<string, any>;
}

/**
 * Actions collection interface
 */
export interface Actions {
  [actionName: string]: Action;
}

/**
 * Action array type
 */
export type ActionArray = Action[];

/**
 * Context interface for actions
 */
export interface ActionContext {
  config?: Record<string, any>;
  withHooks?: (fn: Function) => Function;
  __tags__?: Record<string, any>;
  __requestId__?: string;
  threadId?: string;
  [key: string]: any;
}

/**
 * OpenAPI Parameter in Types
 */
export interface OpenAPIParameter {
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie';
  required?: boolean;
  description?: string;
  schema: JsonSchema;
}

/**
 * OpenAPI Operation Details
 */
export interface OpenAPIOperation {
  operationId: string;
  summary?: string;
  description?: string;
  parameters?: OpenAPIParameter[];
  requestBody?: {
    content?: {
      'application/json'?: {
        schema?: JsonSchema;
      };
    };
  };
  responses?: {
    [statusCode: string]: {
      description?: string;
      content?: {
        'application/json'?: {
          schema?: JsonSchema;
        };
      };
    };
  };
}

/**
 * OpenAPI Schema Structure
 */
export interface OpenAPISchema {
  paths: Record<string, Record<string, OpenAPIOperation>>;
  servers?: Array<{ url: string }>;
  components?: {
    schemas?: Record<string, JsonSchema>;
  };
}

/**
 * Parameter Schema with validator
 */
export interface ParameterSchema {
  key: string;
  value: JsonSchema;
  validator: (data: any) => any;
}

/**
 * Processed action result
 */
export interface ProcessedAction {
  handler: Function;
  spec: string;
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/**
 * Converts a JSON schema to human-readable function spec string
 */
export function jsonSchemaToFunctionSpec(
  inputSchema: JsonSchema,
  functionName: string = '',
  outputSchema?: JsonSchema
): string {
  const properties = inputSchema.properties || {};
  const required = inputSchema.required || [];

  const formatType = (type: string | undefined, format?: string): string => {
    if (type === 'integer') return 'number';
    if (type === 'string' && format === 'date-time') return 'date';
    return type || 'any';
  };

  const formatDescription = (description?: string): string => {
    return description ? ` (${description})` : '';
  };

  /**
   * Recursively format a schema property for function spec
   */
  const formatSchemaProperty = (name: string, schema: JsonSchema, isRequired: boolean, depth = 0): string => {
    // Handle undefined schema case
    if (!schema) {
      return `${isRequired ? '!' : ''}${name}<any>`;
    }
    
    const type = formatType(
      Array.isArray(schema.type) ? schema.type[0] : schema.type,
      schema.format
    );
    const prefix = isRequired ? '!' : '';
    const description = formatDescription(schema.description);
    
    // Special case for object properties we want to show in expanded format at depth 0
    if (type === 'object' && schema.properties && 
        Object.keys(schema.properties).length > 0 && 
        depth === 0) {
      // For top-level objects, we want to show an expanded version
      // Create a detailed spec showing all sub-properties
      const subProps = Object.entries(schema.properties).map(([subName, subSchema]) => {
        const subType = formatType(
          Array.isArray((subSchema as JsonSchema).type) 
            ? (subSchema as JsonSchema).type![0] 
            : (subSchema as JsonSchema).type,
          (subSchema as JsonSchema).format
        );
          
        let typeStr = subType;
        
        // Add enum values if they exist
        if ((subSchema as JsonSchema).enum && (subSchema as JsonSchema).enum!.length > 0) {
          typeStr += `[${(subSchema as JsonSchema).enum!.join('|')}]`;
        }
        
        const subDesc = (subSchema as JsonSchema).description 
          ? ` (${(subSchema as JsonSchema).description})` 
          : '';
          
        return `${subName}<${typeStr}>${subDesc}`;
      }).join(', ');
      
      if (subProps) {
        // Return as a formatted object showing its properties
        return `${prefix}${name}<object{${subProps}}>${description}`;
      }
    }
    
    // Handle arrays specially to show item types
    if (type === 'array' && schema.items) {
      const itemSchema = Array.isArray(schema.items) 
        ? schema.items[0]
        : schema.items;
      
      // If no item schema is defined, just show array
      if (!itemSchema) {
        return `${prefix}${name}<array>${description}`;
      }
      
      // Get item type
      const itemType = formatType(
        Array.isArray((itemSchema as JsonSchema).type)
          ? (itemSchema as JsonSchema).type![0] 
          : (itemSchema as JsonSchema).type,
        (itemSchema as JsonSchema).format
      );
      
      // For simple types or max depth reached or empty objects, just show array<type>
      if (itemType !== 'object' || 
          !(itemSchema as JsonSchema).properties || 
          Object.keys((itemSchema as JsonSchema).properties || {}).length === 0 || 
          depth > 1) {
        // Include enum values if they exist
        let typeDisplay = itemType;
        if ((itemSchema as JsonSchema).enum && (itemSchema as JsonSchema).enum!.length > 0) {
          typeDisplay += `[${(itemSchema as JsonSchema).enum!.join('|')}]`;
        }
        return `${prefix}${name}<array<${typeDisplay}>>${description}`;
      }
      
      // For object arrays, recursively show nested properties of first item
      const arrayProps = Object.entries((itemSchema as JsonSchema).properties || {})
        .map(([childName, childSchema]) => {
          const childIsRequired = Array.isArray((itemSchema as JsonSchema).required) && 
                                (itemSchema as JsonSchema).required!.includes(childName);
          
          return formatSchemaProperty(
            `${name}[].${childName}`, 
            childSchema as JsonSchema,
            childIsRequired,
            depth + 1
          );
        })
        .filter(prop => prop) // Filter out empty strings
        .join(', ');
      
      // If no properties were found after filtering, use the simple format
      if (!arrayProps) {
        return `${prefix}${name}<array<${itemType}>>${description}`;
      }
      
      return arrayProps;
    }
    
    // For non-object types or max depth reached or empty objects, use simple format
    if (type !== 'object' || 
        !schema.properties || 
        Object.keys(schema.properties).length === 0 || 
        depth > 2) {
      // Include enum values if they exist
      let typeDisplay = type;
      if (schema.enum && schema.enum.length > 0) {
        typeDisplay += `[${schema.enum.join('|')}]`;
      }
      return `${prefix}${name}<${typeDisplay}>${description}`;
    }
    
    // For nested objects, recursively format nested properties
    const nestedProps = Object.entries(schema.properties)
      .map(([propName, propSchema]) => {
        const nestedRequired = Array.isArray(schema.required) && schema.required.includes(propName);
        return formatSchemaProperty(
          `${name}.${propName}`,
          propSchema as JsonSchema,
          nestedRequired,
          depth + 1
        );
      })
      .filter(prop => prop) // Filter out empty strings
      .join(', ');
    
    // If no properties were found after filtering, use the simple format
    if (!nestedProps) {
      return `${prefix}${name}<${type}>${description}`;
    }
    
    return nestedProps;
  };

  // Format input arguments
  const args = Object.entries(properties)
    .map(([name, schema]) => formatSchemaProperty(name, schema as JsonSchema, required.includes(name)))
    .join(', ');

  // Format output properties if outputSchema is provided
  let outputString = '';
  if (outputSchema && outputSchema.properties) {
    const outputProps = Object.entries(outputSchema.properties)
      .map(([name, schema]) => {
        // Use the same recursive function for outputs
        return formatSchemaProperty(name, schema as JsonSchema, false);
      })
      .join(', ');

    outputString = outputProps || outputSchema.description || 'Result';
  } else {
    outputString = outputSchema?.description || 'Result';
  }

  const functionDescription = inputSchema.description || '';
  // Fix the double arrow issue by ensuring we don't have "-> ->"
  const argsStr = args ? args : '-';
  return `${functionName}${formatDescription(functionDescription)}: ${argsStr} -> (${outputString})`;
}

/**
 * Converts JSON schema to Short Schema format
 */
export function jsonSchemaToShortSchema(schema: JsonSchema, options: { detailed?: boolean } = {}): any {
  const detailed = options.detailed ?? false;

  const convertType = (type: string | string[] | undefined): string => {
    if (!type) return 'any';
    const effectiveType = Array.isArray(type) ? type[0] : type;

    switch (effectiveType) {
      case 'string': return 'string';
      case 'number':
      case 'integer': return 'number';
      case 'boolean': return 'boolean';
      case 'object': return 'object';
      case 'array': return 'array';
      case 'null': return 'null';
      default: return 'any';
    }
  };

  const formatProperties = (properties: Record<string, JsonSchema> = {}, required: string[] = []): Record<string, any> => {
    return Object.entries(properties).reduce((result, [key, prop]) => {
      const type = convertType(prop.type);
      const isRequired = required.includes(key);
      const suffix = isRequired ? '!' : '?';
      const description = detailed && prop.description ? ` ${prop.description}` : '';

      if (type === 'object' && prop.properties) {
        result[key] = formatProperties(prop.properties, prop.required);
      } else if (type === 'array' && prop.items) {
        // Handle array items based on their type
        if (
          !Array.isArray(prop.items) &&
          prop.items.type === 'object' &&
          prop.items.properties
        ) {
          result[key] = [formatProperties(prop.items.properties, prop.items.required)];
        } else {
          // For primitive types in arrays
          const itemType = !Array.isArray(prop.items)
            ? convertType(prop.items.type)
            : 'any';
          result[key] = [itemType];
        }
      } else {
        result[key] = description
          ? `<${type + suffix}>${description}</${type + suffix}>`
          : type + suffix;
      }

      return result;
    }, {} as Record<string, any>);
  };

  return formatProperties(schema.properties, schema.required);
}

/**
 * Deep merge utility
 */
export function mergeDeep<T>(target: T, source: any): T {
  if (!target) return source as T;

  if (Array.isArray(source)) {
    return (Array.isArray(target) ? [...target, ...source] : source) as T;
  }

  if (isObject(source)) {
    const result = { ...target as object } as Record<string, any>;

    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        result[key] = mergeDeep(
          (target as Record<string, any>)[key] || {},
          source[key]
        );
      } else if (Array.isArray(source[key])) {
        result[key] = Array.isArray((target as Record<string, any>)[key])
          ? [...(target as Record<string, any>)[key], ...source[key]]
          : [...source[key]];
      } else {
        result[key] = source[key];
      }
    });

    return result as T;
  }

  return source as T;
}

/**
 * Check if value is an object
 */
export function isObject(item: any): boolean {
  return item && typeof item === 'object' && !Array.isArray(item);
}

/**
 * Check if a string is a data URL
 */
export function isDataUrl(str: string): boolean {
  return typeof str === 'string' && str.startsWith('data:');
}

/**
 * Check if a string is a base64 encoded data URL
 */
export function isBase64(str: string): boolean {
  if (typeof str !== 'string') return false;
  if (str.length < 8) return false; // Minimum viable length for data URL
  if (!str.startsWith('data:')) return false;

  const dataUrlRegex = /^data:([a-z]+\/[a-z0-9-+.]+)?;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  try {
    return dataUrlRegex.test(str);
  } catch {
    return false;
  }
}

/**
 * Extract base64 content from an object
 * Returns the extracted content and removes it from the original object
 */
export function extractBase64Content(
  obj: any,
  path: string = '',
  result: Record<string, string> = {},
  original: any = obj
): Record<string, string> {
  // Handle null or undefined
  if (obj == null) return result;

  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      const newPath = path ? `${path}.${index}` : `${index}`;
      extractBase64Content(item, newPath, result, original);
    });
  } else if (typeof obj === 'object' && obj !== null) {
    Object.entries(obj).forEach(([key, value]) => {
      const newPath = path ? `${path}.${key}` : key;
      extractBase64Content(value, newPath, result, original);
    });
  } else if (isBase64(obj)) {
    result[path] = obj;

    // Remove the base64 content from the original object
    const pathParts = path.split('.');
    let current = original;
    for (let i = 0; i < pathParts.length - 1; i++) {
      current = current[pathParts[i]];
    }
    const lastPart = pathParts[pathParts.length - 1];
    if (Array.isArray(current)) {
      current.splice(parseInt(lastPart), 1);
    } else {
      delete current[lastPart];
    }
  }
  return result;
}

// ============================================================
// OPENAPI HANDLER
// ============================================================

/**
 * Metadata schema for API requests
 */
const metadataSchema: JsonSchema = {
  type: "object",
  properties: {
    thread: {
      type: "object",
      properties: {
        extId: { type: "string" },
        ctx: {
          type: "object",
          additionalProperties: true
        }
      },
      additionalProperties: true
    },
    user: {
      type: "object",
      properties: {
        extId: { type: "string" },
        id: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        ctx: {
          type: "object",
          additionalProperties: true
        },
      },
      additionalProperties: true
    },
    extId: { type: "string" },
    ctx: {
      type: "object",
      additionalProperties: true
    }
  }
};

/**
 * Convert OpenAPI parameters to JSON schema
 */
export function paramsToJsonSchema(parameters: OpenAPIParameter[]): ParameterSchema[] {
  if (!parameters || !parameters.length) return [];

  // Create initial schema objects for different parameter types
  const schemas: Record<string, JsonSchema> = {
    query: {
      type: 'object',
      properties: {},
      required: []
    },
    header: {
      type: 'object',
      properties: {},
      required: []
    },
    path: {
      type: 'object',
      properties: {},
      required: []
    }
  };

  // Process each parameter
  parameters.forEach(param => {
    const { name, required, schema: paramSchema, in: paramIn } = param;

    // Skip if not query, header, or path parameter
    if (!['query', 'header', 'path'].includes(paramIn)) return;

    // Add property to schema
    if (schemas[paramIn] && schemas[paramIn].properties) {
      schemas[paramIn].properties![name] = {
        ...paramSchema,
        description: param.description || undefined
      };
    }

    // Add to required array if parameter is required
    if (required && schemas[paramIn].required) {
      schemas[paramIn].required!.push(name);
    }
  });

  // Convert schemas to array format with validators
  return Object.entries(schemas)
    .filter(([_, schema]) => schema.properties && Object.keys(schema.properties).length > 0)
    .map(([key, schema]) => {
      // Remove required array if empty
      if (schema.required && schema.required.length === 0) {
        const { required, ...schemaWithoutRequired } = schema;
        schema = schemaWithoutRequired;
      }

      return {
        key,
        value: schema,
        validator: (data: any) => validate(jsonSchemaToShortSchema(schema), data)
      };
    });
}

/**
 * Parse an OpenAPI schema and create action handlers
 */
export async function parseOpenAPISchema(
  schemaContent: string,
  config: Record<string, any> = {}
): Promise<ActionArray> {
  let openApiDocument: OpenAPISchema;

  // Parse schema content (handle JSON or YAML)
  try {
    if (schemaContent.trim().startsWith('{')) {
      openApiDocument = JSON.parse(schemaContent);
    } else {
      // Assume YAML
      const { default: YAML } = await import('npm:yaml');
      openApiDocument = YAML.parse(schemaContent);
    }
  } catch (error) {
    throw new Error(`Failed to parse OpenAPI schema: ${error}`);
  }

  const actionsArray: ActionArray = [];

  // Get base URL from servers if available
  let baseUrl = '';
  if (openApiDocument.servers && openApiDocument.servers.length > 0) {
    baseUrl = openApiDocument.servers[0].url;
  }

  // Process all paths
  for (const [path, pathItem] of Object.entries(openApiDocument.paths || {})) {
    // Process all methods in this path
    for (const [method, operation] of Object.entries(pathItem)) {
      // Skip if not a valid HTTP method
      if (!['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(method)) {
        continue;
      }

      // Get operation details
      const operationObj = operation as OpenAPIOperation;
      const operationId = operationObj.operationId || `${method}${path.replace(/[^a-zA-Z0-9]/g, '_')}`;

      // Skip if no operationId
      if (!operationId) {
        console.warn(`Skipping operation without operationId: ${method} ${path}`);
        continue;
      }

      // Extract parameters
      const parameters = operationObj.parameters || [];
      const paramSchemas = paramsToJsonSchema(parameters);

      // Extract request body schema
      let requestBodySchema: JsonSchema | undefined;
      if (operationObj.requestBody?.content?.['application/json']?.schema) {
        requestBodySchema = operationObj.requestBody.content['application/json'].schema;
      }

      // Extract response schema
      let responseSchema: JsonSchema | undefined;
      const successResponse = operationObj.responses?.['200'] || operationObj.responses?.['201'];
      if (successResponse?.content?.['application/json']?.schema) {
        responseSchema = successResponse.content['application/json'].schema;
      }

      // Combine parameter schemas and request body schema
      const inputSchema: JsonSchema = {
        type: 'object',
        properties: {},
        required: []
      };

      // Add parameters to input schema
      for (const { key, value, validator } of paramSchemas) {
        inputSchema.properties![key] = value;

        // If parameter is required, add to required list
        if (parameters.find(p => p.name === key && p.required)) {
          inputSchema.required!.push(key);
        }
      }

      // Add request body properties to input schema if available
      if (requestBodySchema?.properties) {
        inputSchema.properties = {
          ...inputSchema.properties,
          ...requestBodySchema.properties
        };

        // Add required properties from request body
        if (requestBodySchema.required) {
          inputSchema.required = [
            ...inputSchema.required!,
            ...requestBodySchema.required
          ];
        }
      }

      // Create a handler function for this operation
      const handler = async function (params: Record<string, any>) {
        const url = new URL(path, baseUrl);
        const queryParams = new URLSearchParams();
        const headers = new Headers({
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        });

        // Add custom headers from config
        if (config.headers) {
          for (const [key, value] of Object.entries(config.headers)) {
            headers.append(key, String(value));
          }
        }

        // Process parameters
        let requestBody: any = null;

        // First pass - handle all non-body parameters
        for (const param of parameters) {
          const paramName = param.name;
          const paramValue = params[paramName];

          // Skip if parameter not provided
          if (paramValue === undefined || paramValue === null) {
            // If required, should have been caught by validation
            continue;
          }

          // Based on parameter location
          switch (param.in) {
            case 'query':
              queryParams.append(paramName, String(paramValue));
              break;
            case 'path':
              url.pathname = url.pathname.replace(`{${paramName}}`, encodeURIComponent(String(paramValue)));
              break;
            case 'header':
              headers.append(paramName, String(paramValue));
              break;
            // cookie parameters not supported currently
          }
        }

        // Apply query parameters to URL
        if (queryParams.toString()) {
          url.search = queryParams.toString();
        }

        // Add request body if needed
        if (requestBodySchema && method !== 'get' && method !== 'head') {
          // Extract only properties defined in the schema
          requestBody = {};
          for (const key of Object.keys(requestBodySchema.properties || {})) {
            if (params[key] !== undefined) {
              requestBody[key] = params[key];
            }
          }
        }

        // Make the request
        try {
          const response = await fetch(url.toString(), {
            method: method.toUpperCase(),
            headers,
            body: requestBody ? JSON.stringify(requestBody) : undefined
          });

          // Check if response is ok
          if (!response.ok) {
            const errorText = await response.text();
            console.error(`Error in API request to ${operationId}:`, {
              status: response.status,
              statusText: response.statusText,
              body: errorText
            });
            
            let errorData;
            try {
              errorData = JSON.parse(errorText);
            } catch (e) {
              errorData = errorText;
            }

            throw {
              status: response.status,
              statusText: response.statusText,
              data: errorData
            };
          }

          // Parse response
          const contentType = response.headers.get('content-type') || '';

          let responseData;
          if (contentType.includes('application/json')) {
            responseData = await response.json();
            
            // Check if the response structure matches our expected schema
            if (responseSchema && responseSchema.properties) {
              
              // Check if there's a structure mismatch but we can adapt it
              const expectedProps = Object.keys(responseSchema.properties);
              const actualProps = Object.keys(responseData);
              
              // If we see a common API pattern where the data is wrapped in a response object
              if (expectedProps.length > 0 && !expectedProps.some(prop => actualProps.includes(prop))) {
                
                // Some APIs wrap array results in a data/items/results property
                for (const key of ['data', 'items', 'results', 'response']) {
                  if (key in responseData && Array.isArray(responseData[key])) {
                    if (expectedProps.includes('items') || expectedProps.some(p => responseSchema.properties![p].type === 'array')) {
                      const arrayProp = expectedProps.find(p => responseSchema.properties![p].type === 'array') || 'items';
                      
                      // Create adapted response with the expected property
                      const adaptedResponse = { [arrayProp]: responseData[key] };
                      
                      // Copy over any other properties from the original response that match the schema
                      for (const prop of expectedProps) {
                        if (prop !== arrayProp && prop in responseData) {
                          adaptedResponse[prop] = responseData[prop];
                        }
                      }
                      
                      responseData = adaptedResponse;
                      break;
                    }
                  }
                }
              }
            }
          } else if (contentType.includes('text/')) {
            responseData = await response.text();
          } else {
            // Handle binary data (return as base64)
            const buffer = await response.arrayBuffer();
            responseData = `data:${contentType};base64,${btoa(String.fromCharCode(...new Uint8Array(buffer)))}`;
          }

          return responseData;
        } catch (error) {
          console.error(`Error in ${operationId}:`, error);
          if (error instanceof Error) {
            throw {
              error: {
                message: error.message,
                details: error
              }
            };
          }
          throw error;
        }
      };

      // Create a human-readable spec
      const summary = operationObj.summary || operationObj.description || operationId;

      // Format input parameters with detailed descriptions
      const inputParams = [];

      /**
       * Recursively format a schema property for the function spec
       */
      const formatProperty = (
        propName: string, 
        propSchema: JsonSchema, 
        isRequired: boolean, 
        depth = 0
      ): string[] => {
        // Handle undefined schema case
        if (!propSchema) {
          return [`${isRequired ? '!' : ''}${propName}<any>`];
        }
        
        // Get base type and description
        const propType = Array.isArray(propSchema.type) 
          ? propSchema.type[0] 
          : propSchema.type || 'any';
        const required = isRequired ? '!' : '';
        const description = propSchema.description ? ` (${propSchema.description})` : '';
        
        // Special case for object properties we want to show in expanded format at depth 0
        if (propType === 'object' && propSchema.properties && 
            Object.keys(propSchema.properties).length > 0 && 
            depth === 0) {
          // For top-level objects, we want to show an expanded version
          // Create a detailed spec showing all sub-properties
          const subProps = Object.entries(propSchema.properties).map(([subName, subSchema]) => {
            const subType = Array.isArray((subSchema as JsonSchema).type) 
              ? (subSchema as JsonSchema).type![0] 
              : (subSchema as JsonSchema).type || 'any';
              
            let typeStr = subType;
            
            // Add enum values if they exist
            if ((subSchema as JsonSchema).enum && (subSchema as JsonSchema).enum!.length > 0) {
              typeStr += `[${(subSchema as JsonSchema).enum!.join('|')}]`;
            }
            
            const subDesc = (subSchema as JsonSchema).description 
              ? ` (${(subSchema as JsonSchema).description})` 
              : '';
              
            return `${subName}<${typeStr}>${subDesc}`;
          }).join(', ');
          
          if (subProps) {
            // Return as a formatted object showing its properties
            return [`${required}${propName}<object{${subProps}}>${description}`];
          }
        }
        
        // Handle arrays specially to show item types
        if (propType === 'array' && propSchema.items) {
          const itemSchema = Array.isArray(propSchema.items) 
            ? propSchema.items[0]
            : propSchema.items;
          
          // If no item schema is defined, just show array
          if (!itemSchema) {
            return [`${required}${propName}<array>${description}`];
          }
          
          // Get item type
          const itemType = Array.isArray(itemSchema.type)
            ? itemSchema.type[0]
            : itemSchema.type || 'any';
          
          // For simple types or max depth reached, just show array<type>
          if (itemType !== 'object' || !itemSchema.properties || 
              Object.keys(itemSchema.properties).length === 0 || depth > 1) {
            // Include enum values if they exist
            let typeDisplay = itemType;
            if (itemSchema.enum && itemSchema.enum.length > 0) {
              typeDisplay += `[${itemSchema.enum.join('|')}]`;
            }
            return [`${required}${propName}<array<${typeDisplay}>>${description}`];
          }
          
          // For object arrays, recursively show nested properties of first item
          const arrayProps: string[] = [];
          Object.entries(itemSchema.properties).forEach(([childName, childSchema]) => {
            const childIsRequired = Array.isArray(itemSchema.required) && 
                                  itemSchema.required.includes(childName);
            
            const childParams = formatProperty(
              `${propName}[].${childName}`, 
              childSchema as JsonSchema,
              childIsRequired,
              depth + 1
            );
            
            arrayProps.push(...childParams);
          });
          
          // If no properties were added, use the simple format
          if (arrayProps.length === 0) {
            return [`${required}${propName}<array<${itemType}>>${description}`];
          }
          
          return arrayProps;
        }
        
        // For non-object types or max depth reached or empty objects, return simple format
        if (propType !== 'object' || 
            !propSchema.properties || 
            Object.keys(propSchema.properties).length === 0 || 
            depth > 2) {
          // Include enum values if they exist
          let typeDisplay = propType;
          if (propSchema.enum && propSchema.enum.length > 0) {
            typeDisplay += `[${propSchema.enum.join('|')}]`;
          }
          return [`${required}${propName}<${typeDisplay}>${description}`];
        }
        
        // For nested objects, recursively format nested properties
        const result: string[] = [];
        
        Object.entries(propSchema.properties).forEach(([childName, childSchema]) => {
          const childIsRequired = Array.isArray(propSchema.required) && 
                                propSchema.required.includes(childName);
          
          const childParams = formatProperty(
            `${propName}.${childName}`, 
            childSchema as JsonSchema,
            childIsRequired,
            depth + 1
          );
          
          result.push(...childParams);
        });
        
        // If no properties were found, use the simple format
        if (result.length === 0) {
          return [`${required}${propName}<${propType}>${description}`];
        }
        
        return result;
      };

      // Add path parameters
      for (const param of parameters) {
        inputParams.push(...formatProperty(
          param.name, 
          param.schema,
          !!param.required,
          0
        ));
      }

      // Add body parameters if present
      if (requestBodySchema && requestBodySchema.properties) {
        for (const [propName, propSchema] of Object.entries(requestBodySchema.properties)) {
          const propIsRequired = Array.isArray(requestBodySchema.required) && 
                               requestBodySchema.required.includes(propName);
          
          inputParams.push(...formatProperty(
            propName,
            propSchema as JsonSchema,
            propIsRequired,
            0
          ));
        }
      }

      // Format output properties
      const outputParams = [];
      const outputDesc = successResponse?.description || 'Result';

      if (responseSchema && responseSchema.properties) {
        for (const [propName, propSchema] of Object.entries(responseSchema.properties)) {
          const propDetails = propSchema as JsonSchema;
          
          // Handle nested properties recursively
          outputParams.push(...formatProperty(
            propName,
            propDetails,
            false, // Output properties are never required
            0
          ));
        }
      } else {
        outputParams.push(outputDesc);
      }

      // Create the full spec string - fix the double arrow issue
      const inputParamsStr = inputParams.length > 0 ? inputParams.join(', ') : '-';
      const spec = `(${summary}): ${inputParamsStr} -> (${outputParams.join(', ') || 'success'})`;

      // Create an action object for this operation
      actionsArray.push({
        name: operationId,
        displayName: operationObj.summary || operationId,
        description: operationObj.description || operationObj.summary || `${method.toUpperCase()} ${path}`,
        inputSchema,
        outputSchema: responseSchema || { type: 'object', additionalProperties: true },
        handler,
        operationId,
        spec,
        method,
        path,
        baseUrl
      });
    }
  }

  return actionsArray;
}

// ============================================================
// URL HANDLER
// ============================================================

/**
 * Load module from URL (http or data URL)
 */
export async function loadModuleFromUrl(url: string): Promise<Function> {
  let moduleCode: string;

  if (url.startsWith('data:')) {
    // Extract module code from data URL
    const dataUrlParts = url.split(',');
    if (dataUrlParts.length !== 2) {
      throw new Error('Invalid data URL format');
    }

    const isBase64 = dataUrlParts[0].includes('base64');
    moduleCode = isBase64
      ? atob(dataUrlParts[1])
      : decodeURIComponent(dataUrlParts[1]);
  } else {
    // Fetch module from URL
    moduleCode = await fetch(url).then(res => res.text());
  }

  // Create a blob with the module code
  const blob = new Blob([moduleCode], { type: 'application/javascript' });
  const objectUrl = URL.createObjectURL(blob);

  try {
    // Import the module
    const module = await import(objectUrl);

    if (typeof module.default !== 'function') {
      throw new Error(`Module does not export a default function`);
    }

    return module.default;
  } finally {
    // Clean up the object URL
    URL.revokeObjectURL(objectUrl);
  }
}

// ============================================================
// ACTION PROCESSOR
// ============================================================

/**
 * Process an action to make it executable
 */
export async function processAction(
  actionName: string,
  action: Action,
  context: ActionContext
): Promise<Record<string, ProcessedAction>> {
  // Extract action properties
  const {
    name,
    description,
    inputSchema,
    outputSchema,
    handler,
    openAPISchema,
    mcpServer,
    operationId
  } = action;

  // Result object to hold processed actions (may contain multiple for OpenAPI)
  const result: Record<string, ProcessedAction> = {};

  // Process different action types
  if (openAPISchema) {
    // Parse OpenAPI schema and get all operations
    const operations = await parseOpenAPISchema(openAPISchema, context.config || {});

    // No need to match specific operation - create an action for each operation
    if (operations.length === 0) {
      throw new Error(`No operations found in OpenAPI schema for action '${actionName}'`);
    }

    // Process each operation from the schema
    for (const operation of operations) {
      const opId = operation.operationId || operation.name;

      if (!opId) {
        console.warn(`Found operation without ID in OpenAPI schema for action '${actionName}', skipping`);
        continue;
      }

      if (typeof operation.handler !== 'function') {
        console.warn(`Handler for operation '${opId}' is not a function, skipping`);
        continue;
      }

      // Create processed action for this operation
      result[opId] = {
        handler: createWrappedHandler(opId, operation.handler, operation.inputSchema, operation.outputSchema),
        spec: operation.spec || ''
      };
    }

    return result;
  } else if (mcpServer) {
    // TODO: Implement MCP server handler
    throw new Error('MCP server support not implemented yet');
  } else if (handler) {
    // Handle function or URL
    let actionHandler: Function;

    if (typeof handler === 'function') {
      actionHandler = handler;
    } else if (typeof handler === 'string') {
      // Load function from URL
      actionHandler = await loadModuleFromUrl(handler);
    } else {
      throw new Error(`Invalid handler for action '${actionName}'`);
    }

    // Generate spec from schemas if provided
    let actionSpec = '';
    if (inputSchema && outputSchema) {
      const inputDesc = description || name || actionName;
      
      // Generate the input parameters string
      const inputParams = Object.entries(inputSchema.properties || {})
        .map(([paramName, paramSchema]) => {
          const isRequired = Array.isArray(inputSchema.required) && inputSchema.required.includes(paramName);
          return formatSchemaProperty(paramName, paramSchema as JsonSchema, isRequired, 0);
        })
        .join(', ');
      
      // Generate the output parameters
      let outputString = '';
      if (outputSchema.properties) {
        outputString = Object.entries(outputSchema.properties)
          .map(([propName, propSchema]) => {
            return formatSchemaProperty(propName, propSchema as JsonSchema, false, 0);
          })
          .join(', ');
      }
      
      // Format the full spec string
      const argsStr = inputParams || '-';
      const outputStr = outputString || outputSchema.description || 'success';
      actionSpec = `(${inputDesc}): ${argsStr} -> (${outputStr})`;
    } else {
      // Default spec if schemas not provided
      actionSpec = `(${description || name || actionName}): -> (success)`;
    }

    // Add to result
    result[actionName] = {
      handler: createWrappedHandler(actionName, actionHandler, inputSchema, outputSchema),
      spec: actionSpec
    };

    return result;
  } else {
    throw new Error(`Action '${actionName}' has no handler, openAPISchema, or mcpServer specified`);
  }
}

/**
 * Create a wrapped handler function with validation
 */
function createWrappedHandler(
  actionName: string,
  handler: Function,
  inputSchema?: JsonSchema,
  outputSchema?: JsonSchema
): Function {
  // Create a wrapper function that handles validation
  const wrappedHandler = async (args: Record<string, any>): Promise<any> => {
    // Validate input if schema is provided
    let validatedInput = args;

    if (inputSchema) {
      try {
        validatedInput = validate(inputSchema, args);
      } catch (error) {
        console.error(`Input validation error for action '${actionName}':`, error);
        throw {
          error: {
            code: 'VALIDATION_ERROR',
            message: `Invalid input for action '${actionName}'`,
            details: error
          }
        };
      }
    }

    // Execute the handler
    const result = await handler(validatedInput);
    
    // Validate output if schema is provided
    if (outputSchema) {
      try {
        
        // Check if result is compatible with the schema
        if (outputSchema.type === 'object' && typeof result === 'object' && result !== null) {
          // If the schema expects an object and we have an object, proceed with validation
          return validate(outputSchema, result);
        } else if (outputSchema.type === 'array' && Array.isArray(result)) {
          // If the schema expects an array and we have an array, proceed with validation
          return validate(outputSchema, result);
        } else if (outputSchema.type === 'object' && 
                  typeof result === 'object' && 
                  outputSchema.properties && 
                  Object.keys(outputSchema.properties).some(key => key in (result || {}))) {
          // Special case: if some properties match between schema and result, try validation
          return validate(outputSchema, result);
        } else {
          // Log that we're skipping validation due to type mismatch
          console.warn(`[${actionName}] Schema/result type mismatch, skipping validation:`, 
            { schemaType: outputSchema.type, resultType: typeof result }
          );
          return result;
        }
      } catch (error) {
        console.error(`[${actionName}] Output validation error:`, error);
        
        // Check if we can attempt to adapt the response structure
        if (outputSchema.properties && typeof result === 'object' && result !== null) {
          
          try {
            // Create an object with the expected structure
            const adaptedResult: Record<string, any> = {};
            
            // For each property in the schema, try to find a matching property in the result
            for (const propName of Object.keys(outputSchema.properties)) {
              if (propName in result) {
                adaptedResult[propName] = result[propName];
              } else if (
                // Special case: if the schema property is an array and there's an array in the result
                outputSchema.properties[propName].type === 'array' && 
                Object.values(result).some(val => Array.isArray(val))
              ) {
                // Find the first array in the result
                const arrayValue = Object.entries(result).find(([_, val]) => Array.isArray(val));
                if (arrayValue) {
                  adaptedResult[propName] = arrayValue[1];
                }
              }
            }
            
            // If we managed to adapt at least some properties, use the adapted result
            if (Object.keys(adaptedResult).length > 0) {
              return adaptedResult;
            }
          } catch (adaptError) {
            console.error(`[${actionName}] Error adapting result:`, adaptError);
          }
        }
        
        // If adaptation failed or wasn't attempted, return the original result
        return result;
      }
    }

    return result;
  };

  return wrappedHandler;
}

/**
 * Main handler function to process actions configuration
 */
export async function actionHandler(
  this: ActionContext,
  actionsConfig: ActionArray
): Promise<Record<string, Function>> {
  const context = this;
  const { withHooks } = context;
  const processedActions: Record<string, Function> = {};

  // Process each action in the array
  // Process actions in parallel for better performance
  await Promise.all(
    actionsConfig.map(async (action) => {
      // Get the action name, or use a default
      const actionName = action.name || 'unnamed_action';

      try {
        // Process the action - may return multiple actions for OpenAPI schemas
        const actionResults = await processAction(actionName, action, context);

        // Process each result (could be multiple for OpenAPI schemas)
        Object.entries(actionResults).forEach(([resultName, { handler, spec }]) => {
          // Apply hooks if available
          const finalHandler = withHooks ? withHooks(handler) : handler;

          // Create context with action-specific tags
          const actionContext = {
            ...context,
            __tags__: {
              ...context.__tags__,
              action: resultName
            }
          };

          // Bind context and add spec
          const boundHandler = finalHandler.bind(actionContext);
          boundHandler.spec = spec;

          // Add to processed actions
          processedActions[resultName] = boundHandler;
        });
      } catch (error) {
        console.error(`Error processing action '${actionName}':`, error);

        // Create an error handler that throws when called
        const errorHandler = () => {
          throw {
            error: {
              code: 'ACTION_CONFIGURATION_ERROR',
              message: `Failed to configure action '${actionName}'`,
              details: error instanceof Error ? error.message : String(error)
            }
          };
        };

        errorHandler.spec = `(ERROR: ${actionName}): ->(error)`;
        processedActions[actionName] = errorHandler;
      }
    })
  );

  return processedActions;
}

// Export default handler
export default actionHandler; 