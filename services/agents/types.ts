/**
 * Agentic Tool Framework - Core Types & Interfaces
 * Comprehensive type system for autonomous tool execution
 */

// =============================================================================
// CORE TOOL TYPES
// =============================================================================

export type ToolType = 
  | 'function'      // Pre-defined function execution
  | 'api'           // HTTP API calls
  | 'knowledge'     // Knowledge base operations
  | 'ai'            // AI model interactions
  | 'web_search'    // Web search operations
  | 'js_execution'  // Dynamic JavaScript execution
  | 'py_execution'  // Python execution via Pyodide
  | 'mcp_server'    // Model Context Protocol server
  | 'file_system'   // File operations
  | 'database'      // Database operations
  | 'workflow';     // Composite workflow execution

export type ToolCategory = 
  | 'core'          // Essential system tools
  | 'integration'   // External service integrations
  | 'execution'     // Code execution environments
  | 'data'          // Data processing and storage
  | 'search'        // Search and retrieval
  | 'utility';      // Helper and utility tools

export enum ExecutionEnvironment {
  MAIN = 'main',          // Main thread execution
  WORKER = 'worker',      // Web worker execution
  SANDBOXED = 'sandboxed', // Sandboxed environment
  ISOLATED = 'isolated',   // Completely isolated execution
  DIRECT = 'direct'        // Direct execution (for testing)
}

// =============================================================================
// TOOL DEFINITION INTERFACES
// =============================================================================

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  type: ToolType;
  category: ToolCategory;
  version: string;
  
  // Execution configuration
  execution: {
    environment: ExecutionEnvironment;
    timeout?: number;
    retries?: number;
    concurrent?: boolean;
    resourceLimits?: ResourceLimits;
  };
  
  // Input/output schemas
  input: {
    schema: JSONSchema;
    required: string[];
    examples?: Record<string, any>[];
  };
  
  output: {
    schema: JSONSchema;
    examples?: Record<string, any>[];
  };
  
  // Connection requirements
  connection?: ConnectionRequirements;
  
  // Permissions and security
  permissions: ToolPermissions;
  
  // Metadata
  metadata: {
    author: string;
    tags: string[];
    documentation?: string;
    externalDocs?: string;
    deprecated?: boolean;
    experimental?: boolean;
  };
}

export interface ResourceLimits {
  maxMemoryMB?: number;
  maxExecutionTimeMs?: number;
  maxOutputSizeKB?: number;
  maxConcurrentExecutions?: number;
  allowNetworkAccess?: boolean;
  allowFileSystemAccess?: boolean;
}

export interface ConnectionRequirements {
  type: 'api' | 'database' | 'file' | 'mcp' | 'none';
  config: {
    // API connections
    baseUrl?: string;
    authentication?: AuthenticationConfig;
    headers?: Record<string, string>;
    
    // Database connections
    connectionString?: string;
    driver?: string;
    
    // File system
    basePath?: string;
    
    // MCP server
    serverUrl?: string;
    protocol?: 'http' | 'websocket' | 'stdio';
    
    // Generic configuration
    [key: string]: any;
  };
}

export interface AuthenticationConfig {
  type: 'bearer' | 'api_key' | 'basic' | 'oauth2' | 'custom';
  credentials: {
    token?: string;
    apiKey?: string;
    username?: string;
    password?: string;
    customHeaders?: Record<string, string>;
  };
  envVars?: {
    tokenVar?: string;
    apiKeyVar?: string;
    usernameVar?: string;
    passwordVar?: string;
  };
}

export interface ToolPermissions {
  read: string[];      // Resources this tool can read from
  write: string[];     // Resources this tool can write to
  execute: string[];   // Commands/functions this tool can execute
  network: string[];   // Domains/IPs this tool can access
  dangerous?: boolean; // Mark as requiring explicit user consent
}

// =============================================================================
// EXECUTION LIFECYCLE INTERFACES
// =============================================================================

export interface ToolExecutionRequest {
  toolId: string;
  input: Record<string, any>;
  context?: ExecutionContext;
  options?: ExecutionOptions;
}

export interface ExecutionContext {
  sessionId: string;
  userId?: string;
  conversationId?: string;
  parentExecutionId?: string;
  metadata?: Record<string, any>;
  
  // Available context from previous executions
  previousResults?: ToolExecutionResult[];
  sharedMemory?: Record<string, any>;
  
  // Security context
  permissions?: ToolPermissions;
  sandbox?: boolean;
}

export interface ExecutionOptions {
  timeout?: number;
  retries?: number;
  validateInput?: boolean;
  validateOutput?: boolean;
  logExecution?: boolean;
  cacheResult?: boolean;
  background?: boolean;
}

export interface ToolExecutionResult {
  executionId: string;
  toolId: string;
  success: boolean;
  
  // Execution metadata
  startTime: string;
  endTime: string;
  duration: number;
  
  // Results
  output?: any;
  error?: ToolExecutionError;
  
  // Validation results
  inputValidation?: ValidationResult;
  outputValidation?: ValidationResult;
  
  // Resource usage
  resourceUsage?: ResourceUsage;
  
  // Context for chaining
  context?: ExecutionContext;
}

export interface ToolExecutionError {
  code: ToolErrorCode;
  message: string;
  details?: any;
  stack?: string;
  retryable?: boolean;
  category: 'validation' | 'connection' | 'execution' | 'timeout' | 'permission' | 'system';
}

export type ToolErrorCode = 
  | 'TOOL_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INVALID_OUTPUT'
  | 'CONNECTION_FAILED'
  | 'EXECUTION_TIMEOUT'
  | 'EXECUTION_FAILED'
  | 'PERMISSION_DENIED'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'VALIDATION_FAILED'
  | 'SYSTEM_ERROR';

export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
  warnings?: ValidationWarning[];
}

export interface ValidationError {
  path: string;
  message: string;
  code: string;
  value?: any;
}

export interface ValidationWarning {
  path: string;
  message: string;
  code: string;
}

export interface ResourceUsage {
  memoryUsedMB?: number;
  cpuTimeMs?: number;
  networkRequests?: number;
  fileOperations?: number;
  outputSizeKB?: number;
}

// =============================================================================
// TOOL REGISTRY INTERFACES
// =============================================================================

export interface ToolRegistry {
  register(tool: ToolDefinition): Promise<void>;
  unregister(toolId: string): Promise<void>;
  get(toolId: string): Promise<ToolDefinition | null>;
  list(options?: ListOptions): Promise<ToolDefinition[]>;
  search(query: string, options?: SearchOptions): Promise<ToolDefinition[]>;
  validate(tool: ToolDefinition): Promise<ValidationResult>;
}

export interface ListOptions {
  category?: ToolCategory;
  type?: ToolType;
  tags?: string[];
  includeDeprecated?: boolean;
  includeExperimental?: boolean;
}

export interface SearchOptions extends ListOptions {
  fuzzy?: boolean;
  limit?: number;
}

// =============================================================================
// TOOL EXECUTOR INTERFACES
// =============================================================================

export interface ToolExecutor {
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
  validate(toolId: string, input: any): Promise<ValidationResult>;
  getCapabilities(toolId: string): Promise<ToolCapabilities>;
  
  // Lifecycle management
  connect(toolId: string): Promise<void>;
  disconnect(toolId: string): Promise<void>;
  isConnected(toolId: string): Promise<boolean>;
  
  // Execution monitoring
  getExecutionStatus(executionId: string): Promise<ExecutionStatus>;
  cancelExecution(executionId: string): Promise<void>;
  getExecutionLogs(executionId: string): Promise<ExecutionLog[]>;
}

export interface ToolCapabilities {
  toolId: string;
  available: boolean;
  connected: boolean;
  connectionStatus?: ConnectionStatus;
  resourceLimits: ResourceLimits;
  lastHealthCheck?: string;
  version: string;
}

export interface ConnectionStatus {
  connected: boolean;
  lastConnectedAt?: string;
  lastError?: string;
  retryCount?: number;
  healthCheckStatus?: 'healthy' | 'degraded' | 'unhealthy';
}

export interface ExecutionStatus {
  executionId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
  progress?: number;
  estimatedTimeRemaining?: number;
  currentStep?: string;
  resourceUsage?: ResourceUsage;
}

export interface ExecutionLog {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  metadata?: Record<string, any>;
}

// =============================================================================
// AGENT INTEGRATION INTERFACES
// =============================================================================

export interface AgentToolRequest {
  tools: string[];          // Available tool IDs
  query: string;           // User query/intent
  context?: AgentContext;  // Conversation context
  options?: AgentOptions;  // Execution options
}

export interface AgentContext {
  conversationHistory?: ConversationMessage[];
  userProfile?: UserProfile;
  sessionMemory?: Record<string, any>;
  constraints?: ExecutionConstraints;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface UserProfile {
  id: string;
  permissions: ToolPermissions;
  preferences?: Record<string, any>;
  restrictions?: string[];
}

export interface ExecutionConstraints {
  maxTools?: number;
  maxExecutionTime?: number;
  allowedCategories?: ToolCategory[];
  forbiddenTools?: string[];
  requireConfirmation?: boolean;
}

export interface AgentOptions {
  autonomous?: boolean;
  maxIterations?: number;
  explainSteps?: boolean;
  confirmDangerous?: boolean;
  streamResults?: boolean;
}

export interface AgentExecutionPlan {
  planId: string;
  steps: AgentExecutionStep[];
  estimatedDuration: number;
  requiredPermissions: ToolPermissions;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface AgentExecutionStep {
  stepId: string;
  toolId: string;
  input: Record<string, any>;
  rationale: string;
  dependencies: string[];
  optional?: boolean;
  requiresConfirmation?: boolean;
}

// =============================================================================
// JSON SCHEMA TYPE (Simplified)
// =============================================================================

export interface JSONSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  enum?: any[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  description?: string;
  examples?: any[];
  default?: any;
  [key: string]: any;
}

// =============================================================================
// UTILITY TYPES
// =============================================================================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;

export interface ServiceResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: Record<string, any>;
}

// =============================================================================
// ERROR CLASSES
// =============================================================================

export class ToolFrameworkError extends Error {
  constructor(
    message: string,
    public code: ToolErrorCode,
    public category: ToolExecutionError['category'],
    public details?: any,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'ToolFrameworkError';
  }
}

export class ToolValidationError extends ToolFrameworkError {
  constructor(message: string, public validationErrors: ValidationError[], details?: any) {
    super(message, 'VALIDATION_FAILED', 'validation', details, false);
    this.name = 'ToolValidationError';
  }
}

export class ToolExecutionTimeoutError extends ToolFrameworkError {
  constructor(message: string, public timeout: number, details?: any) {
    super(message, 'EXECUTION_TIMEOUT', 'timeout', details, true);
    this.name = 'ToolExecutionTimeoutError';
  }
}

export class ToolConnectionError extends ToolFrameworkError {
  constructor(message: string, details?: any) {
    super(message, 'CONNECTION_FAILED', 'connection', details, true);
    this.name = 'ToolConnectionError';
  }
}

export class ToolExecutionError extends ToolFrameworkError {
  constructor(message: string, code: ToolErrorCode = 'EXECUTION_FAILED', details?: any) {
    super(message, code, 'execution', details, false);
    this.name = 'ToolExecutionError';
  }
}

export class AgentError extends Error {
  constructor(
    message: string,
    public code?: string,
    public details?: any
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

// =============================================================================
// EXECUTION ENVIRONMENT TYPES
// =============================================================================

export interface ExecutionResult {
  executionId: string;
  success: boolean;
  output?: any;
  error?: ExecutionError;
  duration: number;
  resourceUsage?: ResourceUsage;
  metadata?: Record<string, any>;
}

export interface ExecutionError {
  message: string;
  stack?: string;
  code: string;
  type: 'syntax' | 'runtime' | 'timeout' | 'memory' | 'security';
}

export interface SecurityPolicy {
  allowUnsafeEval?: boolean;
  allowExternalRequests?: boolean;
  maxCodeLength?: number;
  blockedPatterns?: RegExp[];
  allowedModules?: string[];
}

export interface WorkerMessage {
  type: 'execute' | 'terminate' | 'ping';
  id: string;
  payload?: any;
}

export interface WorkerResponse {
  type: 'result' | 'error' | 'progress';
  id: string;
  payload?: any;
} 