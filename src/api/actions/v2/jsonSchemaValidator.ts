/**
 * JSON Schema Validator
 * A lightweight, functional JSON Schema validator
 */

// Type definitions
export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  required?: string[];
  enum?: any[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  default?: any;
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  not?: JsonSchema;
  $ref?: string;
  $id?: string;
  $schema?: string;
  definitions?: Record<string, JsonSchema>;
  [key: string]: any;
}

export interface ValidationOptions {
  /** Whether to return only the valid data without extra properties */
  stripAdditional?: boolean;
  /** Whether to apply default values when data property is missing */
  useDefaults?: boolean;
  /** Whether to coerce types when possible */
  coerceTypes?: boolean;
  /** Whether to be more flexible with validation for API responses */
  flexibleValidation?: boolean;
}

export interface ValidationError {
  path: string;
  message: string;
  schema: JsonSchema;
  data: any;
}

export class SchemaValidationError extends Error {
  public errors: ValidationError[];
  
  constructor(errors: ValidationError[]) {
    const message = errors.map(e => 
      `${e.path}: ${e.message}`
    ).join('\n');
    
    super(`JSON Schema validation failed:\n${message}`);
    this.name = 'SchemaValidationError';
    this.errors = errors;
  }
}

/**
 * Validates data against a JSON Schema
 * 
 * @param schema - JSON Schema to validate against
 * @param data - Data to validate
 * @param options - Validation options
 * @returns Validated data (with coercion/defaults if specified)
 * @throws SchemaValidationError if validation fails
 */
export function validateJsonSchema<T = any>(
  schema: JsonSchema, 
  data: any, 
  options: ValidationOptions = {}
): T {
  const errors: ValidationError[] = [];
  
  // Apply validation with flexibility if needed
  const validatedData = validateSchema(schema, data, '', errors, {
    stripAdditional: options.stripAdditional || false,
    useDefaults: options.useDefaults || false,
    coerceTypes: options.coerceTypes || false,
    flexibleValidation: options.flexibleValidation || false
  });
  
  if (errors.length > 0) {
    throw new SchemaValidationError(errors);
  }
  
  return validatedData as T;
}

/**
 * Core validation function (internal)
 */
function validateSchema(
  schema: JsonSchema,
  data: any,
  path: string,
  errors: ValidationError[],
  options: ValidationOptions
): any {
  // Handle null or undefined schema
  if (!schema) {
    return data;
  }
  
  // Skip validation if data is null/undefined and schema allows it
  if (data === undefined || data === null) {
    if ((Array.isArray(schema.type) && schema.type.includes('null')) || schema.type === 'null') {
      return data;
    }
    
    // Use default value if available
    if (schema.default !== undefined && options.useDefaults) {
      return schema.default;
    }
    
    // Check if required in flexible mode
    if (options.flexibleValidation) {
      return null;
    }
    
    errors.push({
      path,
      message: 'Value is required',
      schema,
      data
    });
    return data;
  }
  
  // Type validation
  const isTypeValid = validateType(schema, data, path, errors, options);
  
  // If type is invalid and not using flexible validation, return early
  if (!isTypeValid && !options.flexibleValidation) {
    return data;
  }
  
  // Even if type is invalid, try to process the data in flexible mode
  if (schema.type === 'object' || 
      (Array.isArray(schema.type) && schema.type.includes('object')) || 
      schema.properties) {
    return validateObject(schema, data, path, errors, options);
  }
  
  if (schema.type === 'array' || 
      (Array.isArray(schema.type) && schema.type.includes('array')) ||
      schema.items) {
    return validateArray(schema, data, path, errors, options);
  }
  
  if (schema.type === 'string' || 
      (Array.isArray(schema.type) && schema.type.includes('string'))) {
    if (typeof data !== 'string' && options.coerceTypes) {
      return validateString(schema, String(data), path, errors, options);
    }
    return validateString(schema, data, path, errors, options);
  }
  
  if ((schema.type === 'number' || schema.type === 'integer') || 
      (Array.isArray(schema.type) && (schema.type.includes('number') || schema.type.includes('integer')))) {
    if (typeof data !== 'number' && options.coerceTypes) {
      const num = Number(data);
      if (!isNaN(num)) {
        return validateNumber(schema, num, path, errors, options);
      }
    }
    return validateNumber(schema, data, path, errors, options);
  }
  
  // For all other types, return the data as is
  return data;
}

/**
 * Validate data type against schema
 */
function validateType(
  schema: JsonSchema, 
  data: any, 
  path: string,
  errors: ValidationError[],
  options: ValidationOptions
): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  
  // Check if the actual type matches any of the allowed types
  const actualType = getJsonType(data);
  if (types.includes(actualType)) {
    return true;
  }
  
  // Try coercion if enabled
  if (options.coerceTypes) {
    const coerced = coerceType(data, types[0] as JsonSchemaType);
    if (coerced !== undefined) {
      // Replace data with coerced value
      Object.assign(data, coerced);
      return true;
    }
  }
  
  errors.push({
    path,
    message: `Expected ${types.join(' or ')}, received ${actualType}`,
    schema,
    data
  });
  
  return false;
}

/**
 * Get JSON Schema type of a value
 */
function getJsonType(value: any): JsonSchemaType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  
  const type = typeof value;
  if (type === 'number') {
    // In JSON Schema, an integer is a number without a decimal part
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  
  if (type === 'string' || type === 'boolean' || type === 'object') {
    return type as JsonSchemaType;
  }
  
  return 'string'; // Default fallback
}

/**
 * Try to coerce a value to the specified type
 */
function coerceType(value: any, targetType: JsonSchemaType): any {
  switch (targetType) {
    case 'string':
      // Convert to string
      return String(value);
    case 'number':
    case 'integer':
      // Convert to number if possible
      if (typeof value === 'string' && !isNaN(Number(value))) {
        const num = Number(value);
        if (targetType === 'integer') {
          return Math.floor(num);
        }
        return num;
      }
      return undefined;
    case 'boolean':
      // Convert to boolean
      if (value === 'true' || value === '1' || value === 1) return true;
      if (value === 'false' || value === '0' || value === 0) return false;
      return undefined;
    case 'array':
      // Convert to array if not already
      if (!Array.isArray(value)) {
        return [value];
      }
      return undefined;
    case 'object':
      // Cannot coerce primitives to objects
      if (typeof value !== 'object') {
        return undefined;
      }
      return value;
    default:
      return undefined;
  }
}

/**
 * Validate object against schema
 */
function validateObject(
  schema: JsonSchema,
  data: any,
  path: string,
  errors: ValidationError[],
  options: ValidationOptions
): any {
  // Handle non-objects in coerce mode
  if (typeof data !== 'object' || data === null) {
    if (options.coerceTypes) {
      try {
        const obj = JSON.parse(String(data));
        if (typeof obj === 'object' && obj !== null) {
          data = obj;
        } else {
          data = {};
        }
      } catch {
        data = {};
      }
    } else if (!options.flexibleValidation) {
      errors.push({
        path,
        message: `Expected object, received ${data === null ? 'null' : typeof data}`,
        schema,
        data
      });
      return data;
    } else {
      // In flexible mode, try to continue with an empty object
      data = {};
    }
  }
  
  const result: Record<string, any> = options.stripAdditional ? {} : { ...data };
  const properties = schema.properties || {};
  const required = schema.required || [];
  
  // Check required properties
  for (const prop of required) {
    if (!(prop in data) && !options.flexibleValidation) {
      errors.push({
        path: path ? `${path}.${prop}` : prop,
        message: `Missing required property: ${prop}`,
        schema: properties[prop] || {},
        data: undefined
      });
    }
  }
  
  // Validate properties
  for (const [key, propSchema] of Object.entries(properties)) {
    const propPath = path ? `${path}.${key}` : key;
    const propValue = data[key];
    
    // Apply default if property is missing and useDefaults option is true
    if (propValue === undefined && options.useDefaults && 'default' in propSchema) {
      result[key] = propSchema.default;
      continue;
    }
    
    // Skip validation of missing optional properties
    if (propValue === undefined && !required.includes(key)) {
      continue;
    }
    
    // Validate and transform property
    result[key] = validateSchema(propSchema, propValue, propPath, errors, options);
  }
  
  // Handle additionalProperties
  if (schema.additionalProperties === false && !options.flexibleValidation) {
    const extraProps = Object.keys(data).filter(
      key => !Object.keys(properties).includes(key)
    );
    
    if (extraProps.length > 0) {
      errors.push({
        path,
        message: `Additional properties not allowed: ${extraProps.join(', ')}`,
        schema,
        data
      });
    }
  } else if (typeof schema.additionalProperties === 'object') {
    // Validate additional properties against schema
    const knownProps = Object.keys(properties);
    
    for (const key of Object.keys(data)) {
      if (!knownProps.includes(key)) {
        const propPath = path ? `${path}.${key}` : key;
        result[key] = validateSchema(
          schema.additionalProperties as JsonSchema,
          data[key],
          propPath,
          errors,
          options
        );
      }
    }
  }
  
  return result;
}

/**
 * Validate array against schema
 */
function validateArray(
  schema: JsonSchema,
  data: any[],
  path: string,
  errors: ValidationError[],
  options: ValidationOptions
): any[] {
  // If data is not an array and we're in flexible mode, try to convert it
  if (!Array.isArray(data)) {
    if (options.flexibleValidation) {
      // If data is object with a property that contains an array, use that
      if (typeof data === 'object' && data !== null) {
        for (const [key, value] of Object.entries(data)) {
          if (Array.isArray(value)) {
            console.log(`Flexible validation: using ${key} as array value`);
            data = value;
            break;
          }
        }
      }
      
      // If still not an array, try to wrap in an array
      if (!Array.isArray(data)) {
        if (data === null || data === undefined) {
          data = [];
        } else {
          data = [data];
        }
      }
    } else {
      errors.push({
        path,
        message: `Expected array, received ${data === null ? 'null' : typeof data}`,
        schema,
        data
      });
      return data as any[];
    }
  }
  
  // Check minItems and maxItems constraints
  if (schema.minItems !== undefined && data.length < schema.minItems && !options.flexibleValidation) {
    errors.push({
      path,
      message: `Array must have at least ${schema.minItems} items`,
      schema,
      data
    });
  }
  
  if (schema.maxItems !== undefined && data.length > schema.maxItems && !options.flexibleValidation) {
    errors.push({
      path,
      message: `Array must have at most ${schema.maxItems} items`,
      schema,
      data
    });
  }
  
  // Handle uniqueItems constraint
  if (schema.uniqueItems && !options.flexibleValidation) {
    const uniqueValues = new Set();
    const duplicates: any[] = [];
    
    for (const item of data) {
      const stringified = JSON.stringify(item);
      if (uniqueValues.has(stringified)) {
        duplicates.push(item);
      } else {
        uniqueValues.add(stringified);
      }
    }
    
    if (duplicates.length > 0) {
      errors.push({
        path,
        message: `Array must have unique items, found duplicates: ${JSON.stringify(duplicates)}`,
        schema,
        data
      });
    }
  }
  
  // Validate items against schema
  const result: any[] = [];
  
  if (schema.items) {
    if (Array.isArray(schema.items)) {
      // Tuple validation - each item has its own schema
      const itemSchemas = schema.items as JsonSchema[];
      
      // Validate items with corresponding schemas
      for (let i = 0; i < data.length; i++) {
        const itemSchema = i < itemSchemas.length ? itemSchemas[i] : schema.additionalItems as JsonSchema;
        
        if (i >= itemSchemas.length && schema.additionalItems === false && !options.flexibleValidation) {
          errors.push({
            path: `${path}[${i}]`,
            message: 'Additional items not allowed in tuple',
            schema,
            data: data[i]
          });
          result.push(data[i]);
        } else if (itemSchema) {
          result.push(validateSchema(itemSchema, data[i], `${path}[${i}]`, errors, options));
        } else {
          result.push(data[i]);
        }
      }
    } else {
      // All items use the same schema
      const itemSchema = schema.items as JsonSchema;
      
      for (let i = 0; i < data.length; i++) {
        result.push(validateSchema(itemSchema, data[i], `${path}[${i}]`, errors, options));
      }
    }
  } else {
    // No item schema provided, return as is
    return data;
  }
  
  return result;
}

/**
 * Validate string against schema
 */
function validateString(
  schema: JsonSchema,
  data: string,
  path: string,
  errors: ValidationError[],
  options: ValidationOptions
): string {
  // Check minLength
  if (typeof schema.minLength === 'number' && data.length < schema.minLength) {
    errors.push({
      path,
      message: `String must be at least ${schema.minLength} characters long`,
      schema,
      data
    });
  }
  
  // Check maxLength
  if (typeof schema.maxLength === 'number' && data.length > schema.maxLength) {
    errors.push({
      path,
      message: `String must be at most ${schema.maxLength} characters long`,
      schema,
      data
    });
  }
  
  // Check pattern
  if (schema.pattern) {
    const regex = new RegExp(schema.pattern);
    if (!regex.test(data)) {
      errors.push({
        path,
        message: `String must match pattern: ${schema.pattern}`,
        schema,
        data
      });
    }
  }
  
  // Check format (only basic formats are supported)
  if (schema.format) {
    const isValid = validateFormat(data, schema.format);
    if (!isValid) {
      errors.push({
        path,
        message: `String must be a valid ${schema.format}`,
        schema,
        data
      });
    }
  }
  
  return data;
}

/**
 * Validate format of string
 */
function validateFormat(value: string, format: string): boolean {
  switch (format) {
    case 'date-time':
      return !isNaN(Date.parse(value));
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value));
    case 'time':
      return /^\d{2}:\d{2}:\d{2}$/.test(value);
    case 'email':
      return /^[^@]+@[^@]+\.[^@]+$/.test(value);
    case 'hostname':
      return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(value);
    case 'ipv4':
      return /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(value);
    case 'ipv6':
      return /^(?:(?:[a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}|(?:[a-fA-F0-9]{1,4}:){1,7}:|(?:[a-fA-F0-9]{1,4}:){1,6}:[a-fA-F0-9]{1,4}|(?:[a-fA-F0-9]{1,4}:){1,5}(?::[a-fA-F0-9]{1,4}){1,2}|(?:[a-fA-F0-9]{1,4}:){1,4}(?::[a-fA-F0-9]{1,4}){1,3}|(?:[a-fA-F0-9]{1,4}:){1,3}(?::[a-fA-F0-9]{1,4}){1,4}|(?:[a-fA-F0-9]{1,4}:){1,2}(?::[a-fA-F0-9]{1,4}){1,5}|[a-fA-F0-9]{1,4}:(?:(?::[a-fA-F0-9]{1,4}){1,6})|:(?:(?::[a-fA-F0-9]{1,4}){1,7}|:))$/.test(value);
    case 'uri':
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    default:
      return true; // Unknown formats are considered valid
  }
}

/**
 * Validate number against schema
 */
function validateNumber(
  schema: JsonSchema,
  data: number,
  path: string,
  errors: ValidationError[],
  options: ValidationOptions
): number {
  // Check minimum
  if (typeof schema.minimum === 'number') {
    if (data < schema.minimum) {
      errors.push({
        path,
        message: `Value must be >= ${schema.minimum}`,
        schema,
        data
      });
    }
  }
  
  // Check maximum
  if (typeof schema.maximum === 'number') {
    if (data > schema.maximum) {
      errors.push({
        path,
        message: `Value must be <= ${schema.maximum}`,
        schema,
        data
      });
    }
  }
  
  // Check multipleOf
  if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
    if (data % schema.multipleOf !== 0) {
      errors.push({
        path,
        message: `Value must be a multiple of ${schema.multipleOf}`,
        schema,
        data
      });
    }
  }
  
  // Check type is integer if specified
  if (schema.type === 'integer' && !Number.isInteger(data)) {
    errors.push({
      path,
      message: `Value must be an integer`,
      schema,
      data
    });
  }
  
  return data;
}

/**
 * Deep equality check for two values
 */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  
  if (a === null || b === null || 
      a === undefined || b === undefined ||
      typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, idx) => deepEqual(val, b[idx]));
  }
  
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  
  if (keysA.length !== keysB.length) return false;
  
  return keysA.every(key => 
    keysB.includes(key) && deepEqual(a[key], b[key])
  );
}

/**
 * Simplified validation function that's more tolerant of API responses
 */
export function validate<T = any>(schema: JsonSchema, data: any, options: ValidationOptions = { flexibleValidation: true }): T {
  // For API validation, default to flexible validation
  if (options.flexibleValidation === undefined) {
    options.flexibleValidation = true;
  }
  
  try {
    return validateJsonSchema<T>(schema, data, options);
  } catch (error) {
    if (options.flexibleValidation) {
      console.warn('Flexible validation - returning original data despite validation error:', 
        error instanceof Error ? error.message : String(error)
      );
      return data as T;
    }
    throw error;
  }
}

export default validate; 