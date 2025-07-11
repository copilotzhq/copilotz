/**
 * Agentic Tool Framework - Execution Environment
 * Sandboxed execution using web workers with resource limits and security
 */

import type {
  ExecutionEnvironment,
  ExecutionContext,
  ExecutionResult,
  ResourceLimits,
  ExecutionError,
  SecurityPolicy,
  WorkerMessage,
  WorkerResponse
} from './types.ts';

// =============================================================================
// EXECUTION ENVIRONMENT MANAGER
// =============================================================================

export class ExecutionEnvironmentManager {
  private workers = new Map<string, Worker>();
  private executions = new Map<string, ExecutionContext>();
  private readonly defaultResourceLimits: ResourceLimits = {
    maxMemoryMB: 64,
    maxExecutionTimeMs: 30000,
    maxConcurrentExecutions: 5,
    allowNetworkAccess: false,
    allowFileSystemAccess: false
  };

  constructor(private readonly securityPolicy: SecurityPolicy = {}) {}

  /**
   * Create a new execution environment
   */
  async createEnvironment(
    environment: ExecutionEnvironment,
    resourceLimits?: ResourceLimits
  ): Promise<string> {
    const envId = this.generateId();
    const limits = { ...this.defaultResourceLimits, ...resourceLimits };

    console.log(`🔧 Creating execution environment: ${envId} (${environment})`);

    try {
      let worker: Worker;

      switch (environment) {
        case 'worker':
          worker = await this.createWebWorker(limits);
          break;
        case 'sandboxed':
          worker = await this.createSandboxedWorker(limits);
          break;
        case 'isolated':
          worker = await this.createIsolatedWorker(limits);
          break;
        case 'direct':
          // Direct execution mode - no worker needed
          this.workers.set(envId, null as any); // Store null to indicate direct mode
          console.log(`✅ Environment created: ${envId} (direct mode)`);
          return envId;
        default:
          throw new Error(`Unsupported execution environment: ${environment}`);
      }

      this.workers.set(envId, worker);
      console.log(`✅ Environment created: ${envId}`);
      return envId;
    } catch (error) {
      console.error(`❌ Failed to create environment: ${envId}`, error);
      throw error;
    }
  }

  /**
   * Execute code in a specific environment
   */
  async execute(
    envId: string,
    code: string,
    context: Partial<ExecutionContext> = {}
  ): Promise<ExecutionResult> {
    if (!this.workers.has(envId)) {
      throw new Error(`Environment not found: ${envId}`);
    }

    const worker = this.workers.get(envId);
    const executionId = this.generateId();
    const fullContext: ExecutionContext = {
      executionId,
      envId,
      code,
      startTime: Date.now(),
      resourceLimits: this.defaultResourceLimits,
      securityPolicy: this.securityPolicy,
      ...context
    };

    this.executions.set(executionId, fullContext);

    console.log(`🚀 Executing code in environment: ${envId} (${executionId})`);

    try {
      let result: ExecutionResult;
      
      if (worker === null) {
        // Direct execution mode
        result = await this.executeDirect(fullContext);
      } else {
        // Worker-based execution
        result = await this.executeInWorker(worker, fullContext);
      }
      
      // Clean up execution context
      this.executions.delete(executionId);
      
      console.log(`✅ Execution completed: ${executionId} (${result.duration}ms)`);
      return result;
    } catch (error) {
      // Clean up execution context
      this.executions.delete(executionId);
      
      console.error(`❌ Execution failed: ${executionId}`, error);
      throw error;
    }
  }

  /**
   * Terminate an execution
   */
  async terminate(executionId: string): Promise<void> {
    const context = this.executions.get(executionId);
    if (!context) {
      return;
    }

    const worker = this.workers.get(context.envId);
    if (worker) {
      worker.terminate();
      this.workers.delete(context.envId);
    }

    this.executions.delete(executionId);
    console.log(`🛑 Terminated execution: ${executionId}`);
  }

  /**
   * Destroy an execution environment
   */
  async destroyEnvironment(envId: string): Promise<void> {
    const worker = this.workers.get(envId);
    if (worker) {
      worker.terminate();
      this.workers.delete(envId);
    }

    // Clean up any executions in this environment
    const executionsToRemove = Array.from(this.executions.entries())
      .filter(([_, context]) => context.envId === envId)
      .map(([executionId]) => executionId);

    executionsToRemove.forEach(executionId => {
      this.executions.delete(executionId);
    });

    console.log(`🗑️ Destroyed environment: ${envId}`);
  }

  /**
   * Get execution status
   */
  getExecutionStatus(executionId: string): ExecutionContext | null {
    return this.executions.get(executionId) || null;
  }

  /**
   * List all active executions
   */
  listExecutions(): ExecutionContext[] {
    return Array.from(this.executions.values());
  }

  /**
   * Get environment statistics
   */
  getStats(): EnvironmentStats {
    return {
      totalEnvironments: this.workers.size,
      activeExecutions: this.executions.size,
      environments: Array.from(this.workers.keys()),
      executions: Array.from(this.executions.keys())
    };
  }

  // =============================================================================
  // PRIVATE METHODS
  // =============================================================================

  /**
   * Execute code directly in the main thread with basic safety measures
   */
  private async executeDirect(context: ExecutionContext): Promise<ExecutionResult> {
    const startTime = Date.now();
    const logs: Array<{ level: string; args: any[]; timestamp: number }> = [];
    
    // Create console interceptor
    const originalConsole = globalThis.console;
    const interceptedConsole = {
      log: (...args: any[]) => {
        logs.push({ level: 'info', args, timestamp: Date.now() });
        originalConsole.log(...args);
      },
      warn: (...args: any[]) => {
        logs.push({ level: 'warn', args, timestamp: Date.now() });
        originalConsole.warn(...args);
      },
      error: (...args: any[]) => {
        logs.push({ level: 'error', args, timestamp: Date.now() });
        originalConsole.error(...args);
      },
      info: (...args: any[]) => {
        logs.push({ level: 'info', args, timestamp: Date.now() });
        originalConsole.info(...args);
      },
      debug: (...args: any[]) => {
        logs.push({ level: 'debug', args, timestamp: Date.now() });
        originalConsole.debug(...args);
      }
    };

    try {
      // Set up timeout if specified
      const timeout = context.resourceLimits?.maxExecutionTimeMs || 30000;
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Execution timeout')), timeout);
      });

      // Execute code with timeout
      const executionPromise = new Promise((resolve, reject) => {
        try {
          // Temporarily replace console
          (globalThis as any).console = interceptedConsole;
          
          // Create a function to evaluate the code
          const evalFunction = new Function('console', `
            "use strict";
            ${context.code}
          `);
          
          const result = evalFunction(interceptedConsole);
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          // Restore original console
          (globalThis as any).console = originalConsole;
        }
      });

      const result = await Promise.race([executionPromise, timeoutPromise]);
      const duration = Date.now() - startTime;

      return {
        success: true,
        result,
        duration,
        memoryUsage: 0, // Not measurable in direct mode
        logs,
        error: undefined
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Restore original console in case of error
      (globalThis as any).console = originalConsole;
      
      return {
        success: false,
        result: null,
        duration,
        memoryUsage: 0,
        logs,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async createWebWorker(limits: ResourceLimits): Promise<Worker> {
    const workerScript = this.generateWorkerScript('worker', limits);
    const blob = new Blob([workerScript], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    
    const worker = new Worker(workerUrl);
    
    // Clean up blob URL
    URL.revokeObjectURL(workerUrl);
    
    return worker;
  }

  private async createSandboxedWorker(limits: ResourceLimits): Promise<Worker> {
    const workerScript = this.generateWorkerScript('sandboxed', limits);
    const blob = new Blob([workerScript], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    
    const worker = new Worker(workerUrl);
    
    // Clean up blob URL
    URL.revokeObjectURL(workerUrl);
    
    return worker;
  }

  private async createIsolatedWorker(limits: ResourceLimits): Promise<Worker> {
    const workerScript = this.generateWorkerScript('isolated', limits);
    const blob = new Blob([workerScript], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    
    const worker = new Worker(workerUrl);
    
    // Clean up blob URL
    URL.revokeObjectURL(workerUrl);
    
    return worker;
  }

  private generateWorkerScript(environment: ExecutionEnvironment, limits: ResourceLimits): string {
    return `
      // Worker script for ${environment} environment
      let executionTimeout = null;
      let memoryMonitor = null;
      
      // Resource limits
      const LIMITS = ${JSON.stringify(limits)};
      
      // Security context
      const SECURITY_CONTEXT = {
        allowNetworkAccess: ${limits.allowNetworkAccess},
        allowFileSystemAccess: ${limits.allowFileSystemAccess}
      };

      // Memory monitoring
      function startMemoryMonitoring() {
        if (typeof performance !== 'undefined' && performance.memory) {
          memoryMonitor = setInterval(() => {
            const memoryUsage = performance.memory.usedJSHeapSize / (1024 * 1024);
            if (memoryUsage > LIMITS.maxMemoryMB) {
              self.postMessage({
                type: 'error',
                error: {
                  message: 'Memory limit exceeded',
                  code: 'MEMORY_LIMIT_EXCEEDED',
                  details: { memoryUsage, limit: LIMITS.maxMemoryMB }
                }
              });
              self.close();
            }
          }, 1000);
        }
      }

      // Execution timeout
      function startExecutionTimeout() {
        if (LIMITS.maxExecutionTimeMs > 0) {
          executionTimeout = setTimeout(() => {
            self.postMessage({
              type: 'error',
              error: {
                message: 'Execution timeout',
                code: 'EXECUTION_TIMEOUT',
                details: { timeout: LIMITS.maxExecutionTimeMs }
              }
            });
            self.close();
          }, LIMITS.maxExecutionTimeMs);
        }
      }

      // Clean up resources
      function cleanup() {
        if (executionTimeout) {
          clearTimeout(executionTimeout);
          executionTimeout = null;
        }
        if (memoryMonitor) {
          clearInterval(memoryMonitor);
          memoryMonitor = null;
        }
      }

      // Secure execution context
      function createSecureContext() {
        const context = {
          console: {
            log: (...args) => self.postMessage({ type: 'log', level: 'info', args }),
            error: (...args) => self.postMessage({ type: 'log', level: 'error', args }),
            warn: (...args) => self.postMessage({ type: 'log', level: 'warn', args }),
            debug: (...args) => self.postMessage({ type: 'log', level: 'debug', args })
          },
          setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, LIMITS.maxExecutionTimeMs)),
          setInterval: (fn, ms) => setInterval(fn, Math.max(ms, 100)), // Min 100ms
          clearTimeout,
          clearInterval,
          Date,
          Math,
          JSON,
          Object,
          Array,
          String,
          Number,
          Boolean,
          RegExp,
          Error,
          TypeError,
          RangeError,
          SyntaxError
        };

        ${environment === 'sandboxed' ? `
          // Sandboxed environment - limited APIs
          delete context.setTimeout;
          delete context.setInterval;
        ` : ''}

        ${environment === 'isolated' ? `
          // Isolated environment - minimal APIs
          context = {
            console: context.console,
            JSON: context.JSON,
            Math: context.Math,
            Object: context.Object,
            Array: context.Array,
            String: context.String,
            Number: context.Number,
            Boolean: context.Boolean
          };
        ` : ''}

        return context;
      }

      // Message handler
      self.onmessage = function(e) {
        const { type, code, context: execContext } = e.data;

        if (type === 'execute') {
          try {
            // Start monitoring
            startMemoryMonitoring();
            startExecutionTimeout();

            const startTime = Date.now();
            const secureContext = createSecureContext();

            // Execute code in secure context
            const result = (function() {
              'use strict';
              ${environment === 'isolated' ? `
                // Isolated execution - eval in minimal context
                const evalContext = Object.assign({}, secureContext);
                with (evalContext) {
                  return eval(code);
                }
              ` : `
                // Standard execution
                const func = new Function(...Object.keys(secureContext), code);
                return func(...Object.values(secureContext));
              `}
            })();

            const duration = Date.now() - startTime;

            // Clean up
            cleanup();

            // Send result
            self.postMessage({
              type: 'success',
              result,
              duration,
              memoryUsage: typeof performance !== 'undefined' && performance.memory ? 
                performance.memory.usedJSHeapSize / (1024 * 1024) : 0
            });

          } catch (error) {
            cleanup();
            self.postMessage({
              type: 'error',
              error: {
                message: error.message,
                name: error.name,
                stack: error.stack,
                code: 'EXECUTION_ERROR'
              }
            });
          }
        } else if (type === 'terminate') {
          cleanup();
          self.close();
        }
      };

      // Error handler
      self.onerror = function(error) {
        cleanup();
        self.postMessage({
          type: 'error',
          error: {
            message: error.message,
            filename: error.filename,
            lineno: error.lineno,
            colno: error.colno,
            code: 'WORKER_ERROR'
          }
        });
      };

      // Ready signal
      self.postMessage({ type: 'ready' });
    `;
  }

  private async executeInWorker(worker: Worker, context: ExecutionContext): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Execution timeout'));
      }, context.resourceLimits.maxExecutionTimeMs);

      const logs: Array<{ level: string; args: any[] }> = [];
      
      const handleMessage = (event: MessageEvent) => {
        const message: WorkerResponse = event.data;
        
        switch (message.type) {
          case 'ready':
            // Worker is ready, send execution command
            worker.postMessage({
              type: 'execute',
              code: context.code,
              context
            } as WorkerMessage);
            break;
            
          case 'success':
            clearTimeout(timeout);
            worker.removeEventListener('message', handleMessage);
            
            resolve({
              success: true,
              result: message.result,
              duration: message.duration || Date.now() - context.startTime,
              memoryUsage: message.memoryUsage,
              logs,
              executionId: context.executionId
            });
            break;
            
          case 'error':
            clearTimeout(timeout);
            worker.removeEventListener('message', handleMessage);
            
            reject(new ExecutionError(
              message.error?.message || 'Unknown execution error',
              message.error?.code || 'EXECUTION_ERROR',
              message.error?.details
            ));
            break;
            
          case 'log':
            logs.push({
              level: message.level || 'info',
              args: message.args || []
            });
            break;
            
          default:
            console.warn('Unknown worker message type:', message.type);
        }
      };

      worker.addEventListener('message', handleMessage);

      worker.addEventListener('error', (error) => {
        clearTimeout(timeout);
        worker.removeEventListener('message', handleMessage);
        reject(new ExecutionError(
          error.message || 'Worker error',
          'WORKER_ERROR',
          { error }
        ));
      });
    });
  }

  private generateId(): string {
    return `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// =============================================================================
// EXECUTION FACTORY
// =============================================================================

/**
 * Create a new execution environment manager
 */
export function createExecutionEnvironment(securityPolicy?: SecurityPolicy): ExecutionEnvironmentManager {
  return new ExecutionEnvironmentManager(securityPolicy);
}

/**
 * Global execution environment manager
 */
let globalExecutionManager: ExecutionEnvironmentManager | null = null;

/**
 * Get the global execution environment manager
 */
export function getGlobalExecutionEnvironment(): ExecutionEnvironmentManager {
  if (!globalExecutionManager) {
    globalExecutionManager = createExecutionEnvironment();
  }
  return globalExecutionManager;
}

/**
 * Reset the global execution environment (useful for testing)
 */
export function resetGlobalExecutionEnvironment(): void {
  globalExecutionManager = null;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Execute code in a temporary environment
 */
export async function executeCode(
  code: string,
  environment: ExecutionEnvironment = 'worker',
  resourceLimits?: ResourceLimits
): Promise<ExecutionResult> {
  const manager = getGlobalExecutionEnvironment();
  
  const envId = await manager.createEnvironment(environment, resourceLimits);
  
  try {
    const result = await manager.execute(envId, code);
    return result;
  } finally {
    await manager.destroyEnvironment(envId);
  }
}

/**
 * Execute multiple code snippets in parallel
 */
export async function executeCodeBatch(
  codeSnippets: Array<{
    code: string;
    environment?: ExecutionEnvironment;
    resourceLimits?: ResourceLimits;
  }>
): Promise<ExecutionResult[]> {
  const manager = getGlobalExecutionEnvironment();
  
  const executions = codeSnippets.map(async ({ code, environment = 'worker', resourceLimits }) => {
    const envId = await manager.createEnvironment(environment, resourceLimits);
    
    try {
      return await manager.execute(envId, code);
    } finally {
      await manager.destroyEnvironment(envId);
    }
  });

  return Promise.all(executions);
}

/**
 * Create a persistent execution environment
 */
export async function createPersistentEnvironment(
  environment: ExecutionEnvironment = 'worker',
  resourceLimits?: ResourceLimits
): Promise<{
  envId: string;
  execute: (code: string) => Promise<ExecutionResult>;
  destroy: () => Promise<void>;
}> {
  const manager = getGlobalExecutionEnvironment();
  const envId = await manager.createEnvironment(environment, resourceLimits);
  
  return {
    envId,
    execute: (code: string) => manager.execute(envId, code),
    destroy: () => manager.destroyEnvironment(envId)
  };
}

// =============================================================================
// TYPES
// =============================================================================

export interface EnvironmentStats {
  totalEnvironments: number;
  activeExecutions: number;
  environments: string[];
  executions: string[];
} 