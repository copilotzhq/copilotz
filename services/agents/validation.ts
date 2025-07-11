/**
 * Agentic Tool Framework - Validation System
 * Comprehensive input/output validation using JSON schemas
 */

import type {
  JSONSchema,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  ToolDefinition,
  ToolValidationError
} from './types.ts';

// =============================================================================
// CORE VALIDATOR CLASS
// =============================================================================

export class SchemaValidator {
  private readonly strictMode: boolean;
  private readonly coerceTypes: boolean;

  constructor(options: ValidatorOptions = {}) {
    this.strictMode = options.strictMode ?? false;
    this.coerceTypes = options.coerceTypes ?? true;
  }

  /**
   * Validate input against a tool's input schema
   */
  async validateInput(tool: ToolDefinition, input: any): Promise<ValidationResult> {
    return this.validate(input, tool.input.schema, {
      context: `Tool ${tool.id} input`,
      required: tool.input.required || []
    });
  }

  /**
   * Validate output against a tool's output schema
   */
  async validateOutput(tool: ToolDefinition, output: any): Promise<ValidationResult> {
    return this.validate(output, tool.output.schema, {
      context: `Tool ${tool.id} output`
    });
  }

  /**
   * Main validation method
   */
  async validate(data: any, schema: JSONSchema, options: ValidationOptions = {}): Promise<ValidationResult> {
    const context = new ValidationContext({
      strictMode: this.strictMode,
      coerceTypes: this.coerceTypes,
      ...options
    });

    try {
      const validatedData = await this.validateValue(data, schema, '', context);
      
      return {
        valid: context.errors.length === 0,
        errors: context.errors.length > 0 ? context.errors : undefined,
        warnings: context.warnings.length > 0 ? context.warnings : undefined
      };
    } catch (error) {
      return {
        valid: false,
        errors: [{
          path: '',
          message: error instanceof Error ? error.message : String(error),
          code: 'VALIDATION_ERROR',
          value: data
        }]
      };
    }
  }

  /**
   * Validate and coerce a value according to schema
   */
  private async validateValue(
    value: any, 
    schema: JSONSchema, 
    path: string, 
    context: ValidationContext
  ): Promise<any> {
    // Handle null values
    if (value === null || value === undefined) {
      if (schema.type === 'null' || (schema.type !== 'null' && !context.required.includes(this.getFieldName(path)))) {
        return value;
      }
      
      if (context.required.includes(this.getFieldName(path))) {
        context.addError(path, 'Required field is missing', 'REQUIRED_FIELD', value);
        return value;
      }
    }

    // Type-specific validation
    switch (schema.type) {
      case 'object':
        return this.validateObject(value, schema, path, context);
      case 'array':
        return this.validateArray(value, schema, path, context);
      case 'string':
        return this.validateString(value, schema, path, context);
      case 'number':
        return this.validateNumber(value, schema, path, context);
      case 'boolean':
        return this.validateBoolean(value, schema, path, context);
      case 'null':
        return this.validateNull(value, schema, path, context);
      default:
        context.addError(path, `Unknown schema type: ${schema.type}`, 'INVALID_SCHEMA', value);
        return value;
    }
  }

  private async validateObject(
    value: any, 
    schema: JSONSchema, 
    path: string, 
    context: ValidationContext
  ): Promise<any> {
    // Type coercion
    if (context.coerceTypes && value !== null && value !== undefined) {
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          context.addError(path, 'Cannot parse string as object', 'TYPE_ERROR', value);
          return value;
        }
      }
    }

    // Type check
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      context.addError(path, 'Expected object', 'TYPE_ERROR', value);
      return value;
    }

    const result: any = {};
    const properties = schema.properties || {};
    const required = schema.required || [];

    // Validate each property in schema
    for (const [propName, propSchema] of Object.entries(properties)) {
      const propPath = path ? `${path}.${propName}` : propName;
      const propValue = value[propName];

      // Check required properties
      if (required.includes(propName) && (propValue === undefined || propValue === null)) {
        context.addError(propPath, 'Required property is missing', 'REQUIRED_FIELD', propValue);
        continue;
      }

      // Validate property if it exists
      if (propValue !== undefined) {
        result[propName] = await this.validateValue(propValue, propSchema, propPath, context);
      } else if (propSchema.default !== undefined) {
        result[propName] = propSchema.default;
      }
    }

    // Check for additional properties in strict mode
    if (context.strictMode) {
      for (const propName of Object.keys(value)) {
        if (!properties[propName]) {
          const propPath = path ? `${path}.${propName}` : propName;
          context.addWarning(propPath, 'Additional property not in schema', 'ADDITIONAL_PROPERTY');
        }
      }
    } else {
      // Copy additional properties
      for (const [propName, propValue] of Object.entries(value)) {
        if (!properties[propName]) {
          result[propName] = propValue;
        }
      }
    }

    return result;
  }

  private async validateArray(
    value: any, 
    schema: JSONSchema, 
    path: string, 
    context: ValidationContext
  ): Promise<any> {
    // Type coercion
    if (context.coerceTypes && value !== null && value !== undefined) {
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          context.addError(path, 'Cannot parse string as array', 'TYPE_ERROR', value);
          return value;
        }
      }
      
      if (!Array.isArray(value) && value !== null && value !== undefined) {
        value = [value]; // Single item to array
        context.addWarning(path, 'Coerced single value to array', 'TYPE_COERCION');
      }
    }

    // Type check
    if (!Array.isArray(value)) {
      context.addError(path, 'Expected array', 'TYPE_ERROR', value);
      return value;
    }

    // Validate array items
    if (schema.items) {
      const result = [];
      for (let i = 0; i < value.length; i++) {
        const itemPath = `${path}[${i}]`;
        const validatedItem = await this.validateValue(value[i], schema.items, itemPath, context);
        result.push(validatedItem);
      }
      return result;
    }

    return value;
  }

  private validateString(
    value: any, 
    schema: JSONSchema, 
    path: string, 
    context: ValidationContext
  ): any {
    // Type coercion
    if (context.coerceTypes && value !== null && value !== undefined) {
      if (typeof value !== 'string') {
        value = String(value);
        context.addWarning(path, 'Coerced value to string', 'TYPE_COERCION');
      }
    }

    // Type check
    if (typeof value !== 'string') {
      context.addError(path, 'Expected string', 'TYPE_ERROR', value);
      return value;
    }

    // Length validation
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      context.addError(path, `String too short (minimum: ${schema.minLength})`, 'MIN_LENGTH', value);
    }

    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      context.addError(path, `String too long (maximum: ${schema.maxLength})`, 'MAX_LENGTH', value);
    }

    // Pattern validation
    if (schema.pattern) {
      const regex = new RegExp(schema.pattern);
      if (!regex.test(value)) {
        context.addError(path, `String does not match pattern: ${schema.pattern}`, 'PATTERN_MISMATCH', value);
      }
    }

    // Enum validation
    if (schema.enum && !schema.enum.includes(value)) {
      context.addError(path, `Value not in allowed enum: ${schema.enum.join(', ')}`, 'ENUM_MISMATCH', value);
    }

    return value;
  }

  private validateNumber(
    value: any, 
    schema: JSONSchema, 
    path: string, 
    context: ValidationContext
  ): any {
    // Type coercion
    if (context.coerceTypes && value !== null && value !== undefined) {
      if (typeof value === 'string' && !isNaN(Number(value))) {
        value = Number(value);
        context.addWarning(path, 'Coerced string to number', 'TYPE_COERCION');
      }
    }

    // Type check
    if (typeof value !== 'number' || isNaN(value)) {
      context.addError(path, 'Expected number', 'TYPE_ERROR', value);
      return value;
    }

    // Range validation
    if (schema.minimum !== undefined && value < schema.minimum) {
      context.addError(path, `Number too small (minimum: ${schema.minimum})`, 'MIN_VALUE', value);
    }

    if (schema.maximum !== undefined && value > schema.maximum) {
      context.addError(path, `Number too large (maximum: ${schema.maximum})`, 'MAX_VALUE', value);
    }

    // Enum validation
    if (schema.enum && !schema.enum.includes(value)) {
      context.addError(path, `Value not in allowed enum: ${schema.enum.join(', ')}`, 'ENUM_MISMATCH', value);
    }

    return value;
  }

  private validateBoolean(
    value: any, 
    schema: JSONSchema, 
    path: string, 
    context: ValidationContext
  ): any {
    // Type coercion
    if (context.coerceTypes && value !== null && value !== undefined) {
      if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(lower)) {
          value = true;
          context.addWarning(path, 'Coerced string to boolean true', 'TYPE_COERCION');
        } else if (['false', '0', 'no', 'off'].includes(lower)) {
          value = false;
          context.addWarning(path, 'Coerced string to boolean false', 'TYPE_COERCION');
        }
      } else if (typeof value === 'number') {
        value = Boolean(value);
        context.addWarning(path, 'Coerced number to boolean', 'TYPE_COERCION');
      }
    }

    // Type check
    if (typeof value !== 'boolean') {
      context.addError(path, 'Expected boolean', 'TYPE_ERROR', value);
      return value;
    }

    return value;
  }

  private validateNull(
    value: any, 
    schema: JSONSchema, 
    path: string, 
    context: ValidationContext
  ): any {
    if (value !== null) {
      context.addError(path, 'Expected null', 'TYPE_ERROR', value);
    }
    return value;
  }

  private getFieldName(path: string): string {
    const parts = path.split('.');
    return parts[parts.length - 1];
  }
}

// =============================================================================
// VALIDATION CONTEXT
// =============================================================================

class ValidationContext {
  public readonly errors: ValidationError[] = [];
  public readonly warnings: ValidationWarning[] = [];
  public readonly strictMode: boolean;
  public readonly coerceTypes: boolean;
  public readonly required: string[];
  public readonly context: string;

  constructor(options: ValidationContextOptions) {
    this.strictMode = options.strictMode ?? false;
    this.coerceTypes = options.coerceTypes ?? true;
    this.required = options.required ?? [];
    this.context = options.context ?? '';
  }

  addError(path: string, message: string, code: string, value?: any): void {
    this.errors.push({
      path,
      message: this.context ? `${this.context}: ${message}` : message,
      code,
      value
    });
  }

  addWarning(path: string, message: string, code: string): void {
    this.warnings.push({
      path,
      message: this.context ? `${this.context}: ${message}` : message,
      code
    });
  }
}

// =============================================================================
// VALIDATION UTILITIES
// =============================================================================

/**
 * Quick validation helper for tools
 */
export async function validateToolInput(tool: ToolDefinition, input: any): Promise<ValidationResult> {
  const validator = new SchemaValidator();
  return validator.validateInput(tool, input);
}

/**
 * Quick validation helper for tool outputs
 */
export async function validateToolOutput(tool: ToolDefinition, output: any): Promise<ValidationResult> {
  const validator = new SchemaValidator();
  return validator.validateOutput(tool, output);
}

/**
 * Validate and throw if invalid
 */
export async function validateAndThrow(data: any, schema: JSONSchema, context = ''): Promise<any> {
  const validator = new SchemaValidator();
  const result = await validator.validate(data, schema, { context });
  
  if (!result.valid) {
    throw new ToolValidationError(
      `Validation failed${context ? ` for ${context}` : ''}`,
      result.errors || []
    );
  }
  
  return data;
}

/**
 * Create a validator with specific options
 */
export function createValidator(options: ValidatorOptions = {}): SchemaValidator {
  return new SchemaValidator(options);
}

/**
 * Validate multiple values against schemas
 */
export async function validateBatch(
  items: Array<{ data: any; schema: JSONSchema; context?: string }>
): Promise<ValidationResult[]> {
  const validator = new SchemaValidator();
  
  return Promise.all(
    items.map(({ data, schema, context }) =>
      validator.validate(data, schema, { context })
    )
  );
}

/**
 * Schema composition helpers
 */
export const SchemaBuilders = {
  /**
   * Create a string schema with common patterns
   */
  string(options: StringSchemaOptions = {}): JSONSchema {
    const schema: JSONSchema = { type: 'string' };
    
    if (options.minLength !== undefined) schema.minLength = options.minLength;
    if (options.maxLength !== undefined) schema.maxLength = options.maxLength;
    if (options.pattern !== undefined) schema.pattern = options.pattern;
    if (options.enum !== undefined) schema.enum = options.enum;
    if (options.description !== undefined) schema.description = options.description;
    if (options.default !== undefined) schema.default = options.default;
    
    return schema;
  },

  /**
   * Create a number schema with ranges
   */
  number(options: NumberSchemaOptions = {}): JSONSchema {
    const schema: JSONSchema = { type: 'number' };
    
    if (options.minimum !== undefined) schema.minimum = options.minimum;
    if (options.maximum !== undefined) schema.maximum = options.maximum;
    if (options.enum !== undefined) schema.enum = options.enum;
    if (options.description !== undefined) schema.description = options.description;
    if (options.default !== undefined) schema.default = options.default;
    
    return schema;
  },

  /**
   * Create an object schema
   */
  object(properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema {
    return {
      type: 'object',
      properties,
      required
    };
  },

  /**
   * Create an array schema
   */
  array(items: JSONSchema): JSONSchema {
    return {
      type: 'array',
      items
    };
  },

  /**
   * Create a boolean schema
   */
  boolean(defaultValue?: boolean): JSONSchema {
    const schema: JSONSchema = { type: 'boolean' };
    if (defaultValue !== undefined) schema.default = defaultValue;
    return schema;
  }
};

// =============================================================================
// COMMON SCHEMAS
// =============================================================================

export const CommonSchemas = {
  // Basic types
  string: { type: 'string' as const },
  number: { type: 'number' as const },
  boolean: { type: 'boolean' as const },
  null: { type: 'null' as const },

  // Common patterns
  email: SchemaBuilders.string({
    pattern: '^[\\w\\.-]+@[\\w\\.-]+\\.[a-zA-Z]{2,}$',
    description: 'Valid email address'
  }),

  url: SchemaBuilders.string({
    pattern: '^https?://[\\w\\.-]+',
    description: 'Valid HTTP/HTTPS URL'
  }),

  uuid: SchemaBuilders.string({
    pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    description: 'Valid UUID v4'
  }),

  date: SchemaBuilders.string({
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'Date in YYYY-MM-DD format'
  }),

  datetime: SchemaBuilders.string({
    pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}',
    description: 'ISO 8601 datetime'
  }),

  // Common objects
  error: SchemaBuilders.object({
    message: { type: 'string' },
    code: { type: 'string' },
    details: { type: 'object' }
  }, ['message']),

  success: SchemaBuilders.object({
    success: { type: 'boolean', default: true },
    message: { type: 'string' },
    data: { type: 'object' }
  })
};

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export interface ValidatorOptions {
  strictMode?: boolean;
  coerceTypes?: boolean;
}

interface ValidationOptions {
  context?: string;
  required?: string[];
  strictMode?: boolean;
  coerceTypes?: boolean;
}

interface ValidationContextOptions {
  strictMode?: boolean;
  coerceTypes?: boolean;
  required?: string[];
  context?: string;
}

interface StringSchemaOptions {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: string[];
  description?: string;
  default?: string;
}

interface NumberSchemaOptions {
  minimum?: number;
  maximum?: number;
  enum?: number[];
  description?: string;
  default?: number;
} 