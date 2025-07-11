/**
 * Agentic Tool Framework - Python Execution Tool
 * Safe Python execution using Pyodide in web workers
 */

import type { ToolDefinition } from '../types.ts';
import { SchemaBuilders } from '../validation.ts';

// =============================================================================
// PYTHON EXECUTION TOOL
// =============================================================================

/**
 * Python Execution Tool
 * Executes Python code using Pyodide in a sandboxed web worker
 */
export const pythonExecutionTool: ToolDefinition = {
  id: 'python-execution',
  name: 'Python Execution',
  description: 'Execute Python code using Pyodide in a secure web worker environment',
  version: '1.0.0',
  category: 'execution',
  type: 'py_execution',
  
  input: {
    schema: SchemaBuilders.object({
      code: SchemaBuilders.string({
        description: 'Python code to execute',
        minLength: 1,
        maxLength: 50000
      }),
      packages: SchemaBuilders.array(SchemaBuilders.string({
        description: 'Python packages to install',
        enum: ['numpy', 'pandas', 'matplotlib', 'requests', 'beautifulsoup4', 'scipy', 'scikit-learn', 'sympy', 'pillow', 'lxml']
      })),
      timeout: SchemaBuilders.number({
        description: 'Maximum execution time in milliseconds',
        minimum: 5000,
        maximum: 600000,
        default: 60000
      }),
      memoryLimit: SchemaBuilders.number({
        description: 'Memory limit in MB',
        minimum: 64,
        maximum: 1024,
        default: 256
      }),
      captureOutput: SchemaBuilders.boolean({
        description: 'Capture stdout/stderr output',
        default: true
      }),
      returnLastExpression: SchemaBuilders.boolean({
        description: 'Return the value of the last expression',
        default: true
      }),
      enablePlotting: SchemaBuilders.boolean({
        description: 'Enable matplotlib plotting capabilities',
        default: true
      }),
      strictMode: SchemaBuilders.boolean({
        description: 'Enable strict mode with additional security',
        default: false
      })
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
      stdout: { type: 'string' },
      stderr: { type: 'string' },
      executionTime: { type: 'number' },
      memoryUsage: { type: 'number' },
      packagesInstalled: SchemaBuilders.array({ type: 'string' }),
      plots: SchemaBuilders.array(SchemaBuilders.object({
        title: { type: 'string' },
        format: { type: 'string' },
        data: { type: 'string' }, // Base64 encoded image
        width: { type: 'number' },
        height: { type: 'number' }
      })),
      warnings: SchemaBuilders.array({ type: 'string' })
    }, ['result', 'success', 'executionTime'])
  },
  
  implementation: {
    type: 'function',
    handler: async (input: any) => {
      try {
        const result = await executePython(input);
        return result;
      } catch (error) {
        return {
          result: null,
          success: false,
          error: error.message || String(error),
          stdout: '',
          stderr: '',
          executionTime: 0,
          memoryUsage: 0,
          packagesInstalled: [],
          plots: [],
          warnings: []
        };
      }
    }
  },
  
  permissions: {
    networkAccess: true, // Needed for Pyodide and package downloads
    fileSystemAccess: false,
    requiresAuthentication: false
  },
  
  execution: {
    environment: 'worker',
    timeout: 600000, // 10 minutes for Python
    resourceLimits: {
      maxMemoryMB: 1024,
      maxExecutionTimeMs: 600000,
      maxConcurrentExecutions: 3
    }
  },
  
  metadata: {
    author: 'Copilotz',
    tags: ['python', 'pyodide', 'execution', 'data-science', 'numpy', 'pandas'],
    deprecated: false,
    experimental: false
  }
};

// =============================================================================
// PYTHON EXECUTION IMPLEMENTATION
// =============================================================================

/**
 * Python execution configuration
 */
interface PythonExecutionConfig {
  code: string;
  packages?: string[];
  timeout?: number;
  memoryLimit?: number;
  captureOutput?: boolean;
  returnLastExpression?: boolean;
  enablePlotting?: boolean;
  strictMode?: boolean;
}

/**
 * Python execution result
 */
interface PythonExecutionResult {
  result: any;
  success: boolean;
  error?: string;
  stdout: string;
  stderr: string;
  executionTime: number;
  memoryUsage: number;
  packagesInstalled: string[];
  plots: Array<{
    title: string;
    format: string;
    data: string;
    width: number;
    height: number;
  }>;
  warnings: string[];
}

/**
 * Execute Python code using Pyodide
 */
async function executePython(config: PythonExecutionConfig): Promise<PythonExecutionResult> {
  const {
    code,
    packages = [],
    timeout = 60000,
    memoryLimit = 256,
    captureOutput = true,
    returnLastExpression = true,
    enablePlotting = true,
    strictMode = false
  } = config;

  // Check if we're in Deno environment where Pyodide workers aren't supported
  const isDeno = typeof Deno !== 'undefined';
  if (isDeno) {
    console.log(`⚠️ Python execution not supported in Deno environment (Pyodide requires web workers)`);
    return {
      result: null,
      success: false,
      error: 'Python execution is not supported in Deno environment. Pyodide requires web workers which are not available in Deno CLI.',
      stdout: '',
      stderr: '',
      executionTime: 0,
      memoryUsage: 0,
      packagesInstalled: [],
      plots: [],
      warnings: ['Python execution requires a browser environment or Node.js with web worker support']
    };
  }

  const startTime = Date.now();
  
  // Create Python worker
  const worker = await createPythonWorker(timeout, memoryLimit);
  
  try {
    // Install packages
    const packagesInstalled = await installPackages(worker, packages);
    
    // Execute code
    const result = await executePythonCode(worker, code, {
      captureOutput,
      returnLastExpression,
      enablePlotting,
      strictMode
    });
    
    // Analyze code for warnings
    const warnings = analyzePythonCodeForWarnings(code);
    
    return {
      result: result.result,
      success: result.success,
      error: result.error,
      stdout: result.stdout,
      stderr: result.stderr,
      executionTime: Date.now() - startTime,
      memoryUsage: result.memoryUsage,
      packagesInstalled,
      plots: result.plots,
      warnings
    };
    
  } catch (error) {
    return {
      result: null,
      success: false,
      error: error.message || String(error),
      stdout: '',
      stderr: '',
      executionTime: Date.now() - startTime,
      memoryUsage: 0,
      packagesInstalled: [],
      plots: [],
      warnings: []
    };
  } finally {
    // Clean up worker
    worker.terminate();
  }
}

/**
 * Create Python worker with Pyodide
 */
async function createPythonWorker(timeout: number, memoryLimit: number): Promise<Worker> {
  const workerScript = generatePythonWorkerScript(timeout, memoryLimit);
  const blob = new Blob([workerScript], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(blob);
  
  const worker = new Worker(workerUrl);
  
  // Clean up blob URL
  URL.revokeObjectURL(workerUrl);
  
  // Wait for Pyodide to initialize
  return new Promise((resolve, reject) => {
    const initTimeout = setTimeout(() => {
      reject(new Error('Pyodide initialization timeout'));
    }, 30000);
    
    worker.onmessage = (event) => {
      if (event.data.type === 'ready') {
        clearTimeout(initTimeout);
        resolve(worker);
      } else if (event.data.type === 'error') {
        clearTimeout(initTimeout);
        reject(new Error(event.data.error));
      }
    };
    
    worker.onerror = (error) => {
      clearTimeout(initTimeout);
      reject(error);
    };
  });
}

/**
 * Generate Python worker script
 */
function generatePythonWorkerScript(timeout: number, memoryLimit: number): string {
  return `
    // Python worker script with Pyodide
    let pyodide = null;
    let executionTimeout = null;
    let memoryMonitor = null;
    
    // Configuration
    const CONFIG = {
      timeout: ${timeout},
      memoryLimit: ${memoryLimit},
      pyodideUrl: 'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.js'
    };
    
    // Initialize Pyodide
    importScripts(CONFIG.pyodideUrl);
    
    async function initializePyodide() {
      try {
        pyodide = await loadPyodide({
          indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/',
          stdout: (text) => {
            self.postMessage({
              type: 'stdout',
              data: text
            });
          },
          stderr: (text) => {
            self.postMessage({
              type: 'stderr',
              data: text
            });
          }
        });
        
        // Set up plotting if matplotlib is available
        await pyodide.runPython(\`
import sys
import io
import warnings
warnings.filterwarnings('ignore')

# Capture stdout/stderr
class OutputCapture:
    def __init__(self):
        self.stdout = io.StringIO()
        self.stderr = io.StringIO()
        self.original_stdout = sys.stdout
        self.original_stderr = sys.stderr
    
    def start(self):
        sys.stdout = self.stdout
        sys.stderr = self.stderr
    
    def stop(self):
        sys.stdout = self.original_stdout
        sys.stderr = self.original_stderr
        return self.stdout.getvalue(), self.stderr.getvalue()
    
    def reset(self):
        self.stdout = io.StringIO()
        self.stderr = io.StringIO()

output_capture = OutputCapture()

# Global namespace for code execution
user_namespace = {}
        \`);
        
        self.postMessage({ type: 'ready' });
      } catch (error) {
        self.postMessage({ 
          type: 'error', 
          error: error.message || String(error) 
        });
      }
    }
    
    // Memory monitoring
    function startMemoryMonitoring() {
      if (typeof performance !== 'undefined' && performance.memory) {
        memoryMonitor = setInterval(() => {
          const memoryUsage = performance.memory.usedJSHeapSize / (1024 * 1024);
          if (memoryUsage > CONFIG.memoryLimit) {
            self.postMessage({
              type: 'error',
              error: 'Memory limit exceeded'
            });
            self.close();
          }
        }, 1000);
      }
    }
    
    // Execution timeout
    function startExecutionTimeout() {
      if (CONFIG.timeout > 0) {
        executionTimeout = setTimeout(() => {
          self.postMessage({
            type: 'error',
            error: 'Execution timeout'
          });
          self.close();
        }, CONFIG.timeout);
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
    
    // Install packages
    async function installPackages(packages) {
      if (!packages || packages.length === 0) return [];
      
      const installed = [];
      for (const package of packages) {
        try {
          await pyodide.loadPackage(package);
          installed.push(package);
        } catch (error) {
          console.warn(\`Failed to install package: \${package}\`, error);
        }
      }
      return installed;
    }
    
    // Execute Python code
    async function executePythonCode(code, options = {}) {
      const {
        captureOutput = true,
        returnLastExpression = true,
        enablePlotting = true,
        strictMode = false
      } = options;
      
      try {
        let result = null;
        let stdout = '';
        let stderr = '';
        let plots = [];
        
        // Prepare code for execution
        let execCode = code;
        
        // Handle plotting setup
        if (enablePlotting) {
          execCode = \`
import matplotlib
matplotlib.use('Agg')  # Use non-interactive backend
import matplotlib.pyplot as plt
import base64
import io

# Plot capture function
def capture_plots():
    plots = []
    for i in plt.get_fignums():
        fig = plt.figure(i)
        buffer = io.BytesIO()
        fig.savefig(buffer, format='png', dpi=150, bbox_inches='tight')
        buffer.seek(0)
        plot_data = base64.b64encode(buffer.read()).decode()
        plots.append({
            'title': fig._suptitle.get_text() if fig._suptitle else f'Plot {i}',
            'format': 'png',
            'data': plot_data,
            'width': fig.get_figwidth() * fig.dpi,
            'height': fig.get_figheight() * fig.dpi
        })
        buffer.close()
    return plots

\${execCode}

# Capture plots if any were created
if plt.get_fignums():
    _plots = capture_plots()
    plt.close('all')
else:
    _plots = []
          \`;
        }
        
        // Start output capture
        if (captureOutput) {
          pyodide.runPython('output_capture.start()');
        }
        
        // Start monitoring
        startMemoryMonitoring();
        startExecutionTimeout();
        
        // Execute code
        if (returnLastExpression) {
          // Try to return the last expression
          try {
            result = pyodide.runPython(\`
import ast
import types

def exec_with_return(code_str):
    try:
        # Parse the code
        tree = ast.parse(code_str)
        
        # If the last statement is an expression, modify it to return the value
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            # Convert the last expression to a return statement
            last_expr = tree.body[-1]
            tree.body[-1] = ast.Return(value=last_expr.value)
        
        # Compile and execute
        code_obj = compile(tree, '<string>', 'exec')
        namespace = user_namespace.copy()
        exec(code_obj, namespace)
        
        # Update global namespace
        user_namespace.update(namespace)
        
        # Return the result if there was a return statement
        return namespace.get('__return_value__', None)
    except SyntaxError:
        # If there's a syntax error, try executing normally
        namespace = user_namespace.copy()
        exec(code_str, namespace)
        user_namespace.update(namespace)
        return None

# Execute the code
__return_value__ = exec_with_return(\`\`\`\${execCode}\`\`\`)
__return_value__
            \`);
          } catch (error) {
            // Fallback to regular execution
            pyodide.runPython(execCode);
            result = null;
          }
        } else {
          pyodide.runPython(execCode);
          result = null;
        }
        
        // Stop output capture
        if (captureOutput) {
          const output = pyodide.runPython('output_capture.stop()');
          stdout = output.toJs()[0];
          stderr = output.toJs()[1];
        }
        
        // Get plots if plotting was enabled
        if (enablePlotting) {
          try {
            plots = pyodide.runPython('_plots').toJs();
          } catch (error) {
            plots = [];
          }
        }
        
        // Clean up
        cleanup();
        
        return {
          result: result?.toJs ? result.toJs() : result,
          success: true,
          stdout,
          stderr,
          plots,
          memoryUsage: typeof performance !== 'undefined' && performance.memory ? 
            performance.memory.usedJSHeapSize / (1024 * 1024) : 0
        };
        
      } catch (error) {
        cleanup();
        
        // Stop output capture on error
        if (captureOutput) {
          try {
            const output = pyodide.runPython('output_capture.stop()');
            stdout = output.toJs()[0];
            stderr = output.toJs()[1];
          } catch {}
        }
        
        return {
          result: null,
          success: false,
          error: error.message || String(error),
          stdout: stdout || '',
          stderr: stderr || '',
          plots: [],
          memoryUsage: 0
        };
      }
    }
    
    // Message handler
    self.onmessage = async function(event) {
      const { type, data } = event.data;
      
      switch (type) {
        case 'install_packages':
          try {
            const installed = await installPackages(data.packages);
            self.postMessage({
              type: 'packages_installed',
              packages: installed
            });
          } catch (error) {
            self.postMessage({
              type: 'error',
              error: error.message || String(error)
            });
          }
          break;
          
        case 'execute':
          try {
            const result = await executePythonCode(data.code, data.options);
            self.postMessage({
              type: 'execution_result',
              result: result
            });
          } catch (error) {
            self.postMessage({
              type: 'error',
              error: error.message || String(error)
            });
          }
          break;
          
        case 'terminate':
          cleanup();
          self.close();
          break;
      }
    };
    
    // Error handler
    self.onerror = function(error) {
      cleanup();
      self.postMessage({
        type: 'error',
        error: error.message || String(error)
      });
    };
    
    // Initialize Pyodide
    initializePyodide();
  `;
}

/**
 * Install packages in the Python worker
 */
async function installPackages(worker: Worker, packages: string[]): Promise<string[]> {
  if (!packages || packages.length === 0) return [];
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Package installation timeout'));
    }, 60000);
    
    worker.onmessage = (event) => {
      if (event.data.type === 'packages_installed') {
        clearTimeout(timeout);
        resolve(event.data.packages);
      } else if (event.data.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(event.data.error));
      }
    };
    
    worker.postMessage({
      type: 'install_packages',
      data: { packages }
    });
  });
}

/**
 * Execute Python code in the worker
 */
async function executePythonCode(
  worker: Worker,
  code: string,
  options: {
    captureOutput?: boolean;
    returnLastExpression?: boolean;
    enablePlotting?: boolean;
    strictMode?: boolean;
  }
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Code execution timeout'));
    }, 120000);
    
    worker.onmessage = (event) => {
      if (event.data.type === 'execution_result') {
        clearTimeout(timeout);
        resolve(event.data.result);
      } else if (event.data.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(event.data.error));
      }
    };
    
    worker.postMessage({
      type: 'execute',
      data: { code, options }
    });
  });
}

/**
 * Analyze Python code for warnings
 */
function analyzePythonCodeForWarnings(code: string): string[] {
  const warnings: string[] = [];
  
  // Check for potentially problematic patterns
  if (code.includes('exec(') || code.includes('eval(')) {
    warnings.push('Use of exec() or eval() detected - this can be dangerous');
  }
  
  if (code.includes('__import__') || code.includes('importlib')) {
    warnings.push('Dynamic imports detected - may not work in sandbox');
  }
  
  if (code.includes('os.') || code.includes('subprocess')) {
    warnings.push('System operations detected - they may not work in sandbox');
  }
  
  if (code.includes('open(') && !code.includes('io.')) {
    warnings.push('File operations detected - they may not work in sandbox');
  }
  
  if (code.includes('input(')) {
    warnings.push('Input operations detected - they may not work in sandbox');
  }
  
  if (code.includes('requests.') || code.includes('urllib')) {
    warnings.push('Network requests detected - they may not work in sandbox');
  }
  
  if (code.includes('while True:') || code.includes('while 1:')) {
    warnings.push('Infinite loop detected - this may cause timeout');
  }
  
  return warnings;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Quick Python execution with default settings
 */
export async function quickPython(code: string): Promise<any> {
  const result = await executePython({
    code,
    timeout: 30000,
    memoryLimit: 128,
    captureOutput: true,
    returnLastExpression: true
  });
  
  if (!result.success) {
    throw new Error(result.error || 'Execution failed');
  }
  
  return result.result;
}

/**
 * Execute Python with data science packages
 */
export async function pythonDataScience(
  code: string,
  packages: string[] = ['numpy', 'pandas', 'matplotlib']
): Promise<any> {
  const result = await executePython({
    code,
    packages,
    timeout: 120000,
    memoryLimit: 512,
    captureOutput: true,
    returnLastExpression: true,
    enablePlotting: true
  });
  
  if (!result.success) {
    throw new Error(result.error || 'Execution failed');
  }
  
  return result;
}

/**
 * Execute Python with plotting capabilities
 */
export async function pythonWithPlotting(code: string): Promise<any> {
  const result = await executePython({
    code,
    packages: ['matplotlib', 'numpy'],
    timeout: 60000,
    memoryLimit: 256,
    captureOutput: true,
    returnLastExpression: true,
    enablePlotting: true
  });
  
  if (!result.success) {
    throw new Error(result.error || 'Execution failed');
  }
  
  return result;
}

/**
 * Execute Python with custom configuration
 */
export async function pythonCustom(
  code: string,
  config: Partial<PythonExecutionConfig> = {}
): Promise<PythonExecutionResult> {
  return executePython({
    code,
    timeout: 60000,
    memoryLimit: 256,
    captureOutput: true,
    returnLastExpression: true,
    enablePlotting: true,
    ...config
  });
}

// =============================================================================
// EXPORTS
// =============================================================================

export default pythonExecutionTool;
export { 
  executePython, 
  type PythonExecutionConfig, 
  type PythonExecutionResult 
}; 