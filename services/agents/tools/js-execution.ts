/**
 * Agentic Tool Framework - JavaScript Execution Tool
 * Safe JavaScript execution in sandboxed environments
 */

import type { ToolDefinition } from '../types.ts';
import { SchemaBuilders } from '../validation.ts';
import { getGlobalExecutionEnvironment } from '../execution.ts';

// =============================================================================
// JAVASCRIPT EXECUTION TOOL
// =============================================================================

/**
 * JavaScript Execution Tool
 * Executes JavaScript code in a sandboxed environment
 */
export const jsExecutionTool: ToolDefinition = {
  id: 'js-execution',
  name: 'JavaScript Execution',
  description: 'Execute JavaScript code in a secure sandboxed environment',
  version: '1.0.0',
  category: 'execution',
  type: 'js_execution',
  
  input: {
    schema: SchemaBuilders.object({
      code: SchemaBuilders.string({
        description: 'JavaScript code to execute',
        minLength: 1,
        maxLength: 50000
      }),
      environment: SchemaBuilders.string({
        description: 'Execution environment security level',
        enum: ['worker', 'sandboxed', 'isolated'],
        default: 'sandboxed'
      }),
      timeout: SchemaBuilders.number({
        description: 'Maximum execution time in milliseconds',
        minimum: 1000,
        maximum: 300000,
        default: 30000
      }),
      memoryLimit: SchemaBuilders.number({
        description: 'Memory limit in MB',
        minimum: 16,
        maximum: 512,
        default: 64
      }),
      returnLastExpression: SchemaBuilders.boolean({
        description: 'Return the value of the last expression',
        default: true
      }),
      includeBuiltins: SchemaBuilders.boolean({
        description: 'Include built-in JavaScript functions and objects',
        default: true
      }),
      allowAsync: SchemaBuilders.boolean({
        description: 'Allow async/await and Promise usage',
        default: true
      }),
      libraries: SchemaBuilders.array(SchemaBuilders.string({
        description: 'Additional libraries to include',
        enum: ['lodash', 'moment', 'crypto', 'uuid', 'math']
      }))
    }, ['code']),
    required: ['code']
  },
  
  output: {
    schema: SchemaBuilders.object({
      result: {
        description: 'Execution result',
        oneOf: [
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
          { type: 'object' },
          { type: 'array' },
          { type: 'null' }
        ]
      },
      success: { type: 'boolean' },
      error: { type: 'string' },
      executionTime: { type: 'number' },
      memoryUsage: { type: 'number' },
      logs: SchemaBuilders.array(SchemaBuilders.object({
        level: SchemaBuilders.string({
          enum: ['info', 'warn', 'error', 'debug']
        }),
        message: { type: 'string' },
        timestamp: { type: 'number' }
      })),
      warnings: SchemaBuilders.array({ type: 'string' })
    }, ['result', 'success', 'executionTime'])
  },
  
  implementation: {
    type: 'function',
    handler: async (input: any) => {
      try {
        const result = await executeJavaScript(input);
        return result;
      } catch (error) {
        return {
          result: null,
          success: false,
          error: error.message || String(error),
          executionTime: 0,
          memoryUsage: 0,
          logs: [],
          warnings: []
        };
      }
    }
  },
  
  permissions: {
    networkAccess: false,
    fileSystemAccess: false,
    requiresAuthentication: false
  },
  
  execution: {
    environment: 'sandboxed',
    timeout: 300000,
    resourceLimits: {
      maxMemoryMB: 512,
      maxExecutionTimeMs: 300000,
      maxConcurrentExecutions: 10
    }
  },
  
  metadata: {
    author: 'Copilotz',
    tags: ['javascript', 'execution', 'sandbox', 'code', 'eval'],
    deprecated: false,
    experimental: false
  }
};

// =============================================================================
// JAVASCRIPT EXECUTION IMPLEMENTATION
// =============================================================================

/**
 * JavaScript execution configuration
 */
interface JSExecutionConfig {
  code: string;
  environment?: 'worker' | 'sandboxed' | 'isolated';
  timeout?: number;
  memoryLimit?: number;
  returnLastExpression?: boolean;
  includeBuiltins?: boolean;
  allowAsync?: boolean;
  libraries?: string[];
}

/**
 * JavaScript execution result
 */
interface JSExecutionResult {
  result: any;
  success: boolean;
  error?: string;
  executionTime: number;
  memoryUsage: number;
  logs: Array<{
    level: string;
    message: string;
    timestamp: number;
  }>;
  warnings: string[];
}

/**
 * Execute JavaScript code in a sandboxed environment
 */
async function executeJavaScript(config: JSExecutionConfig): Promise<JSExecutionResult> {
  const {
    code,
    environment = 'sandboxed',
    timeout = 30000,
    memoryLimit = 64,
    returnLastExpression = true,
    includeBuiltins = true,
    allowAsync = true,
    libraries = []
  } = config;

  const executionManager = getGlobalExecutionEnvironment();
  
  // Check if we're in Deno environment where workers aren't supported
  const isDeno = typeof Deno !== 'undefined';
  const effectiveEnvironment = isDeno ? 'direct' : environment;
  
  if (isDeno && environment !== 'direct') {
    console.log(`🔧 Deno environment detected, using direct execution instead of ${environment}`);
  }
  
  // Create execution environment  
  const envId = await executionManager.createEnvironment(effectiveEnvironment as any, {
    maxMemoryMB: memoryLimit,
    maxExecutionTimeMs: timeout,
    maxConcurrentExecutions: 10,
    allowNetworkAccess: false,
    allowFileSystemAccess: false
  });

  try {
    // Prepare code for execution
    const preparedCode = prepareJavaScriptCode(code, {
      returnLastExpression,
      includeBuiltins,
      allowAsync,
      libraries
    });

    // Execute code
    const executionResult = await executionManager.execute(envId, preparedCode);

    // Parse logs
    const logs = executionResult.logs?.map(log => ({
      level: log.level,
      message: Array.isArray(log.args) ? log.args.join(' ') : String(log.args),
      timestamp: Date.now()
    })) || [];

    // Check for warnings
    const warnings = analyzeCodeForWarnings(code);

    return {
      result: executionResult.result,
      success: executionResult.success,
      error: executionResult.success ? undefined : 'Execution failed',
      executionTime: executionResult.duration || 0,
      memoryUsage: executionResult.memoryUsage || 0,
      logs,
      warnings
    };

  } catch (error) {
    return {
      result: null,
      success: false,
      error: error.message || String(error),
      executionTime: 0,
      memoryUsage: 0,
      logs: [],
      warnings: []
    };
  } finally {
    // Clean up execution environment
    await executionManager.destroyEnvironment(envId);
  }
}

/**
 * Prepare JavaScript code for execution
 */
function prepareJavaScriptCode(
  code: string,
  options: {
    returnLastExpression?: boolean;
    includeBuiltins?: boolean;
    allowAsync?: boolean;
    libraries?: string[];
  }
): string {
  const {
    returnLastExpression = true,
    includeBuiltins = true,
    allowAsync = true,
    libraries = []
  } = options;

  let preparedCode = '';

  // Add library imports
  if (libraries.length > 0) {
    preparedCode += generateLibraryCode(libraries);
  }

  // Add built-in utilities
  if (includeBuiltins) {
    preparedCode += generateBuiltinUtilities();
  }

  // Handle async code
  if (allowAsync && containsAsync(code)) {
    preparedCode += `
      (async function() {
        try {
          ${code}
        } catch (error) {
          console.error('Async execution error:', error);
          throw error;
        }
      })().catch(error => {
        console.error('Unhandled async error:', error);
        throw error;
      });
    `;
  } else {
    // Handle return last expression
    if (returnLastExpression) {
      const statements = parseStatements(code);
      if (statements.length > 0) {
        const lastStatement = statements[statements.length - 1];
        if (isExpression(lastStatement)) {
          statements[statements.length - 1] = `return (${lastStatement});`;
        }
      }
      preparedCode += statements.join('\n');
    } else {
      preparedCode += code;
    }
  }

  return preparedCode;
}

/**
 * Generate library code for included libraries
 */
function generateLibraryCode(libraries: string[]): string {
  let libraryCode = '';

  libraries.forEach(library => {
    switch (library) {
      case 'lodash':
        libraryCode += `
          // Lodash utilities (simplified)
          const _ = {
            map: (arr, fn) => arr.map(fn),
            filter: (arr, fn) => arr.filter(fn),
            reduce: (arr, fn, initial) => arr.reduce(fn, initial),
            forEach: (arr, fn) => arr.forEach(fn),
            find: (arr, fn) => arr.find(fn),
            some: (arr, fn) => arr.some(fn),
            every: (arr, fn) => arr.every(fn),
            uniq: (arr) => [...new Set(arr)],
            flatten: (arr) => arr.flat(),
            chunk: (arr, size) => {
              const chunks = [];
              for (let i = 0; i < arr.length; i += size) {
                chunks.push(arr.slice(i, i + size));
              }
              return chunks;
            },
            get: (obj, path) => {
              const keys = path.split('.');
              let result = obj;
              for (const key of keys) {
                result = result?.[key];
              }
              return result;
            }
          };
        `;
        break;

      case 'moment':
        libraryCode += `
          // Moment.js utilities (simplified)
          const moment = {
            now: () => new Date(),
            format: (date, format) => date.toISOString(),
            add: (date, amount, unit) => {
              const d = new Date(date);
              switch (unit) {
                case 'days': d.setDate(d.getDate() + amount); break;
                case 'hours': d.setHours(d.getHours() + amount); break;
                case 'minutes': d.setMinutes(d.getMinutes() + amount); break;
                case 'seconds': d.setSeconds(d.getSeconds() + amount); break;
              }
              return d;
            },
            subtract: (date, amount, unit) => moment.add(date, -amount, unit),
            diff: (date1, date2, unit) => {
              const diff = new Date(date1) - new Date(date2);
              switch (unit) {
                case 'days': return diff / (1000 * 60 * 60 * 24);
                case 'hours': return diff / (1000 * 60 * 60);
                case 'minutes': return diff / (1000 * 60);
                case 'seconds': return diff / 1000;
                default: return diff;
              }
            }
          };
        `;
        break;

      case 'crypto':
        libraryCode += `
          // Crypto utilities (simplified)
          const crypto = {
            randomBytes: (size) => Array.from({length: size}, () => Math.floor(Math.random() * 256)),
            randomUUID: () => {
              return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                const r = Math.random() * 16 | 0;
                const v = c == 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
              });
            },
            hash: (data, algorithm = 'sha256') => {
              // Simplified hash function
              let hash = 0;
              for (let i = 0; i < data.length; i++) {
                const char = data.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash; // Convert to 32bit integer
              }
              return Math.abs(hash).toString(16);
            }
          };
        `;
        break;

      case 'uuid':
        libraryCode += `
          // UUID utilities
          const uuid = {
            v4: () => {
              return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                const r = Math.random() * 16 | 0;
                const v = c == 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
              });
            }
          };
        `;
        break;

      case 'math':
        libraryCode += `
          // Extended Math utilities
          const MathExtended = {
            ...Math,
            clamp: (num, min, max) => Math.min(Math.max(num, min), max),
            lerp: (a, b, t) => a + (b - a) * t,
            map: (value, inMin, inMax, outMin, outMax) => {
              return (value - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
            },
            degToRad: (degrees) => degrees * Math.PI / 180,
            radToDeg: (radians) => radians * 180 / Math.PI,
            isPrime: (n) => {
              if (n < 2) return false;
              for (let i = 2; i <= Math.sqrt(n); i++) {
                if (n % i === 0) return false;
              }
              return true;
            },
            factorial: (n) => {
              if (n <= 1) return 1;
              return n * MathExtended.factorial(n - 1);
            },
            fibonacci: (n) => {
              if (n <= 1) return n;
              let a = 0, b = 1;
              for (let i = 2; i <= n; i++) {
                [a, b] = [b, a + b];
              }
              return b;
            }
          };
        `;
        break;
    }
  });

  return libraryCode;
}

/**
 * Generate built-in utility functions
 */
function generateBuiltinUtilities(): string {
  return `
    // Built-in utilities
    const utils = {
      isType: (value, type) => typeof value === type,
      isArray: (value) => Array.isArray(value),
      isObject: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
      isFunction: (value) => typeof value === 'function',
      isEmpty: (value) => {
        if (value == null) return true;
        if (Array.isArray(value) || typeof value === 'string') return value.length === 0;
        if (typeof value === 'object') return Object.keys(value).length === 0;
        return false;
      },
      deepClone: (obj) => {
        if (obj === null || typeof obj !== 'object') return obj;
        if (obj instanceof Date) return new Date(obj.getTime());
        if (obj instanceof Array) return obj.map(item => utils.deepClone(item));
        if (typeof obj === 'object') {
          const cloned = {};
          for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
              cloned[key] = utils.deepClone(obj[key]);
            }
          }
          return cloned;
        }
        return obj;
      },
      range: (start, end, step = 1) => {
        const result = [];
        for (let i = start; i < end; i += step) {
          result.push(i);
        }
        return result;
      },
      sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
      timeout: (promise, ms) => {
        return Promise.race([
          promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
        ]);
      }
    };
    
    // Make utils available globally
    Object.assign(globalThis, { utils });
  `;
}

/**
 * Check if code contains async/await
 */
function containsAsync(code: string): boolean {
  return /\b(async|await)\b/.test(code);
}

/**
 * Parse statements from code
 */
function parseStatements(code: string): string[] {
  // Simple statement parsing - split by semicolons and newlines
  return code
    .split(/[;\n]/)
    .map(stmt => stmt.trim())
    .filter(stmt => stmt.length > 0);
}

/**
 * Check if a statement is an expression
 */
function isExpression(statement: string): boolean {
  // Simple heuristic: if it doesn't start with keywords, it's likely an expression
  const keywords = ['var', 'let', 'const', 'function', 'class', 'if', 'for', 'while', 'do', 'switch', 'try', 'return', 'throw', 'break', 'continue'];
  const trimmed = statement.trim();
  return !keywords.some(keyword => trimmed.startsWith(keyword)) && !trimmed.includes('=');
}

/**
 * Analyze code for potential warnings
 */
function analyzeCodeForWarnings(code: string): string[] {
  const warnings: string[] = [];

  // Check for potentially dangerous patterns
  if (code.includes('eval(')) {
    warnings.push('Use of eval() detected - this can be dangerous');
  }

  if (code.includes('Function(')) {
    warnings.push('Use of Function constructor detected - this can be dangerous');
  }

  if (code.includes('while(true)') || code.includes('for(;;)')) {
    warnings.push('Infinite loop detected - this may cause timeout');
  }

  if (code.includes('setInterval') || code.includes('setTimeout')) {
    warnings.push('Timer functions detected - they may not work in sandboxed environment');
  }

  if (code.match(/\bfetch\b|\bXMLHttpRequest\b|\bWebSocket\b/)) {
    warnings.push('Network requests detected - they are not allowed in sandboxed environment');
  }

  if (code.includes('document') || code.includes('window') || code.includes('localStorage')) {
    warnings.push('Browser APIs detected - they may not be available in sandboxed environment');
  }

  return warnings;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Quick JavaScript execution with default settings
 */
export async function quickJS(code: string): Promise<any> {
  const result = await executeJavaScript({
    code,
    environment: 'sandboxed',
    timeout: 10000,
    memoryLimit: 32
  });
  
  if (!result.success) {
    throw new Error(result.error || 'Execution failed');
  }
  
  return result.result;
}

/**
 * Execute JavaScript with enhanced utilities
 */
export async function jsWithUtils(code: string, libraries: string[] = []): Promise<any> {
  const result = await executeJavaScript({
    code,
    environment: 'worker',
    timeout: 30000,
    memoryLimit: 64,
    includeBuiltins: true,
    libraries
  });
  
  if (!result.success) {
    throw new Error(result.error || 'Execution failed');
  }
  
  return result.result;
}

/**
 * Execute JavaScript in isolated environment
 */
export async function jsIsolated(code: string): Promise<any> {
  const result = await executeJavaScript({
    code,
    environment: 'isolated',
    timeout: 5000,
    memoryLimit: 16,
    includeBuiltins: false,
    allowAsync: false
  });
  
  if (!result.success) {
    throw new Error(result.error || 'Execution failed');
  }
  
  return result.result;
}

/**
 * Execute JavaScript with custom configuration
 */
export async function jsCustom(
  code: string,
  config: Partial<JSExecutionConfig> = {}
): Promise<JSExecutionResult> {
  return executeJavaScript({
    code,
    environment: 'sandboxed',
    timeout: 30000,
    memoryLimit: 64,
    ...config
  });
}

// =============================================================================
// EXPORTS
// =============================================================================

export default jsExecutionTool;
export { 
  executeJavaScript, 
  type JSExecutionConfig, 
  type JSExecutionResult 
}; 