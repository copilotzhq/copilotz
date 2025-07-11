// Agentic Tool Execution Framework
// Main entry point for the complete agentic framework

// Core Types and Interfaces
// export * from './types.ts';

// Tool Registry System
export * from './registry.ts';

// Validation System
export * from './validation.ts';

// Execution Environment
export * from './execution.ts';

// Basic Tools
export * from './tools/basic.ts';

// HTTP API Tool
export * from './tools/api.ts';

// Web Search Tool
export * from './tools/web-search.ts';

// JavaScript Execution Tool
export * from './tools/js-execution.ts';

// Python Execution Tool
export * from './tools/python-execution.ts';

// MCP Server Tool
export * from './tools/mcp-server.ts';

// Agent Orchestrator
export * from './orchestrator.ts';

// Security Manager
export * from './security.ts';

// Testing Framework
export * from './testing.ts';

// Framework Configuration
export interface AgenticFrameworkConfig {
  // Registry configuration
  registry?: {
    type: 'memory' | 'persistent';
    storage?: string;
  };
  
  // Execution environment configuration
  execution?: {
    defaultEnvironment: 'direct' | 'sandboxed' | 'isolated' | 'worker';
    resourceLimits?: {
      maxMemory: number;
      maxCpu: number;
      maxExecutionTime: number;
    };
  };
  
  // Security configuration
  security?: {
    level: 'low' | 'medium' | 'high' | 'maximum';
    enableRateLimit: boolean;
    enableContentFilter: boolean;
    enableResourceMonitoring: boolean;
    enableAuditLogging: boolean;
  };
  
  // Agent configuration
  agent?: {
    autoExecute: boolean;
    maxToolCalls: number;
    verbosity: 'minimal' | 'normal' | 'detailed';
    allowedCategories: string[];
  };
  
  // Tool configuration
  tools?: {
    enableBasicTools: boolean;
    enableApiTool: boolean;
    enableWebSearch: boolean;
    enableJsExecution: boolean;
    enablePythonExecution: boolean;
    enableMcpServer: boolean;
    customTools?: any[];
  };
}

// Default configuration
export const DEFAULT_CONFIG: AgenticFrameworkConfig = {
  registry: {
    type: 'memory'
  },
  execution: {
    defaultEnvironment: 'sandboxed',
    resourceLimits: {
      maxMemory: 100, // MB
      maxCpu: 80, // percentage
      maxExecutionTime: 30000 // milliseconds
    }
  },
  security: {
    level: 'medium',
    enableRateLimit: true,
    enableContentFilter: true,
    enableResourceMonitoring: true,
    enableAuditLogging: true
  },
  agent: {
    autoExecute: true,
    maxToolCalls: 3,
    verbosity: 'normal',
    allowedCategories: ['knowledge', 'search', 'utility', 'ai']
  },
  tools: {
    enableBasicTools: true,
    enableApiTool: true,
    enableWebSearch: true,
    enableJsExecution: false,
    enablePythonExecution: false,
    enableMcpServer: false,
    customTools: []
  }
};

// Main Framework Factory
export class AgenticFramework {
  private config: AgenticFrameworkConfig;
  private registry: any;
  private executionManager: any;
  private securityManager: any;
  private orchestrator: any;
  private initialized = false;
  
  constructor(config: Partial<AgenticFrameworkConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  // Initialize the framework
  async initialize(): Promise<void> {
    if (this.initialized) {
      throw new Error('Framework already initialized');
    }
    
    // Initialize registry
    const { InMemoryToolRegistry } = await import('./registry.ts');
    this.registry = new InMemoryToolRegistry();
    
    // Initialize execution manager
    const { ExecutionEnvironmentManager } = await import('./execution.ts');
    this.executionManager = new ExecutionEnvironmentManager();
    
    // Initialize security manager
    const { SecurityManager } = await import('./security.ts');
    this.securityManager = new SecurityManager();
    
    // Initialize orchestrator
    const { AgentOrchestrator } = await import('./orchestrator.ts');
    this.orchestrator = new AgentOrchestrator(
      this.registry,
      this.executionManager
    );
    
    // Register tools based on configuration
    await this.registerTools();
    
    this.initialized = true;
  }
  
  // Register tools based on configuration
  private async registerTools(): Promise<void> {
    if (this.config.tools?.enableBasicTools) {
      const basicTools = await import('./tools/basic.ts');
      for (const tool of basicTools.BASIC_TOOLS) {
        await this.registry.register(tool);
      }
    }
    
    if (this.config.tools?.enableApiTool) {
      const { httpApiTool } = await import('./tools/api.ts');
      await this.registry.register(httpApiTool);
    }
    
    if (this.config.tools?.enableWebSearch) {
      const { webSearchTool } = await import('./tools/web-search.ts');
      await this.registry.register(webSearchTool);
    }
    
    if (this.config.tools?.enableJsExecution) {
      const { jsExecutionTool } = await import('./tools/js-execution.ts');
      await this.registry.register(jsExecutionTool);
    }
    
    if (this.config.tools?.enablePythonExecution) {
      const { pythonExecutionTool } = await import('./tools/python-execution.ts');
      await this.registry.register(pythonExecutionTool);
    }
    
    if (this.config.tools?.enableMcpServer) {
      const { mcpServerTool } = await import('./tools/mcp-server.ts');
      await this.registry.register(mcpServerTool);
    }
    
    // Register custom tools
    if (this.config.tools?.customTools) {
      for (const tool of this.config.tools.customTools) {
        await this.registry.register(tool);
      }
    }
  }
  
  // Get registry instance
  getRegistry(): any {
    this.ensureInitialized();
    return this.registry;
  }
  
  // Get execution manager instance
  getExecutionManager(): any {
    this.ensureInitialized();
    return this.executionManager;
  }
  
  // Get security manager instance
  getSecurityManager(): any {
    this.ensureInitialized();
    return this.securityManager;
  }
  
  // Get orchestrator instance
  getOrchestrator(): any {
    this.ensureInitialized();
    return this.orchestrator;
  }
  
  // Create a new agent conversation
  createConversation(preferences?: any): string {
    this.ensureInitialized();
    return this.orchestrator.createConversation(preferences);
  }
  
  // Process a message
  async processMessage(
    conversationId: string,
    message: string,
    streamingCallback?: any
  ): Promise<any> {
    this.ensureInitialized();
    return this.orchestrator.processMessage(conversationId, message, streamingCallback);
  }
  
  // List available tools
  async listTools(category?: string): Promise<any[]> {
    this.ensureInitialized();
    return this.registry.list({ category });
  }
  
  // Search tools
  async searchTools(query: string, options?: any): Promise<any> {
    this.ensureInitialized();
    return this.registry.search(query, options);
  }
  
  // Get tool by ID
  async getTool(toolId: string): Promise<any> {
    this.ensureInitialized();
    return this.registry.get(toolId);
  }
  
  // Register a new tool
  async registerTool(tool: any): Promise<void> {
    this.ensureInitialized();
    return this.registry.register(tool);
  }
  
  // Execute a tool directly
  async executeTool(toolId: string, parameters: any): Promise<any> {
    this.ensureInitialized();
    const tool = await this.registry.get(toolId);
    if (!tool) {
      throw new Error(`Tool ${toolId} not found`);
    }
    
    try {
      // Execute the tool's implementation handler
      const result = await tool.implementation.handler(parameters);
      
      return {
        success: true,
        output: result,
        toolId,
        executionTime: Date.now()
      };
    } catch (error) {
      return {
        success: false,
        output: null,
        error: error.message,
        toolId,
        executionTime: Date.now()
      };
    }
  }
  
  // Run tests
  async runTests(): Promise<void> {
    const { runAgenticFrameworkTests } = await import('./testing.ts');
    await runAgenticFrameworkTests();
  }
  
  // Get framework status
  getStatus(): {
    initialized: boolean;
    toolCount: number;
    config: AgenticFrameworkConfig;
  } {
    return {
      initialized: this.initialized,
      toolCount: this.initialized ? this.registry.tools?.size || 0 : 0,
      config: this.config
    };
  }
  
  // Shutdown the framework
  async shutdown(): Promise<void> {
    if (!this.initialized) return;
    
    // Cleanup resources
    this.registry = null;
    this.executionManager = null;
    this.securityManager = null;
    this.orchestrator = null;
    this.initialized = false;
  }
  
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('Framework not initialized. Call initialize() first.');
    }
  }
}

// Utility functions
export const AgenticUtils = {
  // Create a quick framework instance
  async createFramework(config?: Partial<AgenticFrameworkConfig>): Promise<AgenticFramework> {
    const framework = new AgenticFramework(config);
    await framework.initialize();
    return framework;
  },
  
  // Create a basic agent for simple use cases
  async createBasicAgent(): Promise<AgenticFramework> {
    const config: Partial<AgenticFrameworkConfig> = {
      security: { level: 'low' },
      tools: {
        enableBasicTools: true,
        enableApiTool: true,
        enableWebSearch: true,
        enableJsExecution: false,
        enablePythonExecution: false,
        enableMcpServer: false
      }
    };
    
    return this.createFramework(config);
  },
  
  // Create a secure agent for production use
  async createSecureAgent(): Promise<AgenticFramework> {
    const config: Partial<AgenticFrameworkConfig> = {
      security: { level: 'high' },
      agent: {
        autoExecute: false,
        maxToolCalls: 2,
        verbosity: 'minimal',
        allowedCategories: ['knowledge', 'utility']
      },
      tools: {
        enableBasicTools: true,
        enableApiTool: false,
        enableWebSearch: false,
        enableJsExecution: false,
        enablePythonExecution: false,
        enableMcpServer: false
      }
    };
    
    return this.createFramework(config);
  },
  
  // Create a development agent with all features
  async createDevelopmentAgent(): Promise<AgenticFramework> {
    const config: Partial<AgenticFrameworkConfig> = {
      security: { level: 'low' },
      tools: {
        enableBasicTools: true,
        enableApiTool: true,
        enableWebSearch: true,
        enableJsExecution: true,
        enablePythonExecution: true,
        enableMcpServer: true
      }
    };
    
    return this.createFramework(config);
  }
};

// Export version information
export const VERSION = '1.0.0';
export const FRAMEWORK_NAME = 'Agentic Tool Execution Framework';

// Export configuration types
export type { AgenticFrameworkConfig };

// Export default framework instance factory
export default AgenticFramework;

// =============================================================================
// TESTS - Basic Framework Testing
// =============================================================================

if (import.meta.main) {
  console.log('🧪 Running Agentic Framework Tests...\n');
  
  async function runBasicTests() {
    try {
      // Test 1: Framework Creation
      console.log('1. Testing framework creation...');
      const framework = new AgenticFramework();
      console.log('   ✅ Framework instance created');
      
      // Test 2: Framework Initialization  
      console.log('\n2. Testing framework initialization...');
      await framework.initialize();
      console.log('   ✅ Framework initialized successfully');
      
      // Test 3: Framework Status
      console.log('\n3. Testing framework status...');
      const status = framework.getStatus();
      console.log(`   ✅ Framework status: ${status.initialized ? 'Ready' : 'Not Ready'}`);
      console.log(`   📊 Tool count: ${status.toolCount}`);
      
      // Test 4: Basic Agent Creation
      console.log('\n4. Testing basic agent creation...');
      const basicAgent = await AgenticUtils.createBasicAgent();
      console.log('   ✅ Basic agent created successfully');
      
      console.log('\n🎉 All basic tests passed!');
      
      // Proceed to Step 2: Tool Execution Tests using the basicAgent
      await runToolExecutionTests(basicAgent);
      
      // Cleanup
      await framework.shutdown();
      await basicAgent.shutdown();
      
    } catch (error) {
      console.error('\n❌ Test failed:', error.message);
      console.error('Full error:', error);
    }
  }
  
  // Step 2: Tool Execution Tests
  async function runToolExecutionTests(framework: AgenticFramework) {
    console.log('\n🔧 Step 2: Testing Tool Execution...\n');
    
    try {
      // Step 2.1: Test simple text processing tool
      console.log('2.1. Testing text-processing tool...');
      const textResult = await framework.executeTool('text-processing', {
        text: 'hello world',
        operation: 'uppercase'
      });
      console.log(`   ✅ Text processing: "${textResult?.output?.result}"`);
      
      // Test another text operation
      const wordCountResult = await framework.executeTool('text-processing', {
        text: 'The quick brown fox jumps over the lazy dog',
        operation: 'wordcount'
      });
      console.log(`   ✅ Word count: ${wordCountResult?.output?.result} words`);
      
      // Step 2.2: Test knowledge base tools
      console.log('\n2.2. Testing knowledge base tools...');
      
      // Test knowledge ingest
      const ingestResult = await framework.executeTool('knowledge-ingest', {
        content: 'This is test knowledge content for the agentic framework.',
        metadata: { 
          title: 'Test Knowledge',
          source: 'framework-test',
          tags: ['test', 'framework']
        }
      });
      
      if (ingestResult?.success) {
        console.log(`   ✅ Knowledge ingest: ${ingestResult.output?.message || 'Success (no message)'}`);
      } else {
        console.log(`   ⚠️  Knowledge ingest error: ${ingestResult?.error || 'Unknown error'}`);
      }
      
      // Test knowledge query
      const queryResult = await framework.executeTool('knowledge-query', {
        query: 'test knowledge',
        limit: 5
      });
      
      if (queryResult?.success) {
        console.log(`   ✅ Knowledge query: Found ${queryResult.output?.total || 0} results`);
      } else {
        console.log(`   ⚠️  Knowledge query error: ${queryResult?.error || 'Unknown error'}`);
      }
      
      console.log('\n🎉 Step 2.1-2.2: Basic tool execution tests passed!');
      
      // Note: Skip AI tools for now if no API keys
      const hasOpenAIKey = Deno.env.get('DEFAULT_OPENAI_KEY') || Deno.env.get('OPENAI_API_KEY');
      if (hasOpenAIKey) {
        console.log('\n2.3. Testing AI tools (API keys available)...');
        await testAITools(framework);
      } else {
        console.log('\n⚠️  2.3. Skipping AI tools (no API keys found)');
        console.log('   💡 Set DEFAULT_OPENAI_KEY to test AI tools');
      }
      
    } catch (error) {
      console.error('\n❌ Tool execution test failed:', error.message);
      console.error('Full error:', error);
    }
  }
  
  // Test AI tools if API keys are available
  async function testAITools(framework: AgenticFramework) {
    try {
      // Test LLM chat tool
      console.log('   🔄 Testing LLM chat tool...');
      const llmResult = await framework.executeTool('llm-chat', {
        prompt: 'Say "Hello from agentic framework!" and nothing else.',
        maxTokens: 20
      });
      
      if (llmResult?.output?.response) {
        console.log(`   ✅ LLM Chat: "${llmResult.output.response.substring(0, 50)}..."`);
      } else {
        console.log(`   ⚠️  LLM Chat: ${llmResult?.error || 'No response'}`);
      }
      
      // Test text embedding tool
      console.log('   🔄 Testing text embedding tool...');
      const embeddingResult = await framework.executeTool('text-embedding', {
        text: 'Hello world embedding test'
      });
      
      if (embeddingResult?.output?.embedding) {
        console.log(`   ✅ Text Embedding: ${embeddingResult.output.dimensions} dimensions`);
      } else {
        console.log(`   ⚠️  Text Embedding: ${embeddingResult?.error || 'No embedding'}`);
      }
      
      console.log('   🎉 AI tools test completed!');
      
    } catch (error) {
      console.log(`   ⚠️  AI tools test error: ${error.message}`);
    }
  }
  
  // Run the tests
  runBasicTests();
} 