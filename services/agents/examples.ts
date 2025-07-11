// Agentic Tool Execution Framework - Usage Examples
// This file demonstrates various ways to use the framework

import { AgenticFramework, AgenticUtils, AgenticFrameworkConfig } from './index.ts';

// Example 1: Basic Agent Setup
export async function basicAgentExample() {
  console.log('=== Basic Agent Example ===');
  
  // Create a basic agent with minimal configuration
  const agent = await AgenticUtils.createBasicAgent();
  
  // Create a conversation
  const conversationId = agent.createConversation();
  console.log('Conversation created:', conversationId);
  
  // Process a simple message
  const response = await agent.processMessage(
    conversationId,
    'Hello! Can you help me search for information about artificial intelligence?'
  );
  
  console.log('Agent response:', response.content);
  
  // List available tools
  const tools = await agent.listTools();
  console.log('Available tools:', tools.map(t => t.name));
  
  await agent.shutdown();
}

// Example 2: Secure Agent for Production
export async function secureAgentExample() {
  console.log('\n=== Secure Agent Example ===');
  
  // Create a secure agent with high security settings
  const agent = await AgenticUtils.createSecureAgent();
  
  // Create conversation with specific preferences
  const conversationId = agent.createConversation({
    verbosity: 'minimal',
    autoExecute: false, // Require manual approval
    maxToolCalls: 1,
    allowedCategories: ['knowledge', 'utility']
  });
  
  // Process message with security constraints
  const response = await agent.processMessage(
    conversationId,
    'Calculate the square root of 144'
  );
  
  console.log('Secure agent response:', response.content);
  
  await agent.shutdown();
}

// Example 3: Development Agent with All Features
export async function developmentAgentExample() {
  console.log('\n=== Development Agent Example ===');
  
  // Create a development agent with all features enabled
  const agent = await AgenticUtils.createDevelopmentAgent();
  
  // Create conversation
  const conversationId = agent.createConversation({
    verbosity: 'detailed',
    autoExecute: true,
    maxToolCalls: 5
  });
  
  // Process complex request
  const response = await agent.processMessage(
    conversationId,
    'Write a Python script to calculate fibonacci numbers and then execute it'
  );
  
  console.log('Development agent response:', response.content);
  
  await agent.shutdown();
}

// Example 4: Custom Configuration
export async function customConfigurationExample() {
  console.log('\n=== Custom Configuration Example ===');
  
  // Define custom configuration
  const config: Partial<AgenticFrameworkConfig> = {
    registry: {
      type: 'memory'
    },
    execution: {
      defaultEnvironment: 'sandboxed',
      resourceLimits: {
        maxMemory: 50, // 50MB limit
        maxCpu: 70,    // 70% CPU limit
        maxExecutionTime: 10000 // 10 second limit
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
      maxToolCalls: 2,
      verbosity: 'normal',
      allowedCategories: ['knowledge', 'search', 'utility']
    },
    tools: {
      enableBasicTools: true,
      enableApiTool: true,
      enableWebSearch: true,
      enableJsExecution: false,
      enablePythonExecution: false,
      enableMcpServer: false
    }
  };
  
  // Create framework with custom configuration
  const framework = new AgenticFramework(config);
  await framework.initialize();
  
  // Use the framework
  const conversationId = framework.createConversation();
  const response = await framework.processMessage(
    conversationId,
    'What is the current weather in New York?'
  );
  
  console.log('Custom configured agent response:', response.content);
  
  // Check framework status
  const status = framework.getStatus();
  console.log('Framework status:', status);
  
  await framework.shutdown();
}

// Example 5: Streaming Response Example
export async function streamingResponseExample() {
  console.log('\n=== Streaming Response Example ===');
  
  const agent = await AgenticUtils.createBasicAgent();
  const conversationId = agent.createConversation();
  
  // Define streaming callback
  const streamingCallback = (response: any) => {
    console.log(`[${response.type}] ${response.content}`);
  };
  
  // Process message with streaming
  const response = await agent.processMessage(
    conversationId,
    'Explain quantum computing in simple terms',
    streamingCallback
  );
  
  console.log('Final response:', response.content);
  
  await agent.shutdown();
}

// Example 6: Direct Tool Execution
export async function directToolExecutionExample() {
  console.log('\n=== Direct Tool Execution Example ===');
  
  const agent = await AgenticUtils.createBasicAgent();
  
  // List available tools
  const tools = await agent.listTools();
  console.log('Available tools:', tools.map(t => ({ id: t.id, name: t.name })));
  
  // Execute a specific tool directly
  if (tools.length > 0) {
    const toolId = tools[0].id;
    console.log(`Executing tool: ${toolId}`);
    
    const result = await agent.executeTool(toolId, {
      query: 'What is machine learning?'
    });
    
    console.log('Tool execution result:', result);
  }
  
  await agent.shutdown();
}

// Example 7: Error Handling
export async function errorHandlingExample() {
  console.log('\n=== Error Handling Example ===');
  
  const agent = await AgenticUtils.createBasicAgent();
  
  try {
    // Try to execute a non-existent tool
    const result = await agent.executeTool('non-existent-tool', {});
    console.log('This should not print');
  } catch (error) {
    console.log('Caught expected error:', error.message);
  }
  
  try {
    // Try to process message in non-existent conversation
    const response = await agent.processMessage('invalid-id', 'Hello');
    console.log('This should not print');
  } catch (error) {
    console.log('Caught expected error:', error.message);
  }
  
  await agent.shutdown();
}

// Example 8: Multi-Conversation Management
export async function multiConversationExample() {
  console.log('\n=== Multi-Conversation Example ===');
  
  const agent = await AgenticUtils.createBasicAgent();
  
  // Create multiple conversations
  const conv1 = agent.createConversation({ verbosity: 'minimal' });
  const conv2 = agent.createConversation({ verbosity: 'detailed' });
  const conv3 = agent.createConversation({ verbosity: 'normal' });
  
  // Process messages in different conversations
  const response1 = await agent.processMessage(conv1, 'What is AI?');
  const response2 = await agent.processMessage(conv2, 'Explain neural networks');
  const response3 = await agent.processMessage(conv3, 'How does machine learning work?');
  
  console.log('Conversation 1 response:', response1.content.substring(0, 100) + '...');
  console.log('Conversation 2 response:', response2.content.substring(0, 100) + '...');
  console.log('Conversation 3 response:', response3.content.substring(0, 100) + '...');
  
  // Get conversation details
  const orchestrator = agent.getOrchestrator();
  const conversations = orchestrator.listConversations();
  console.log(`Total conversations: ${conversations.length}`);
  
  await agent.shutdown();
}

// Example 9: Custom Tool Registration
export async function customToolExample() {
  console.log('\n=== Custom Tool Example ===');
  
  const agent = await AgenticUtils.createBasicAgent();
  
  // Define a custom tool
  const customTool = {
    id: 'custom-calculator',
    name: 'Custom Calculator',
    description: 'A custom calculator tool for basic arithmetic operations',
    category: 'utility',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
        a: { type: 'number' },
        b: { type: 'number' }
      },
      required: ['operation', 'a', 'b']
    },
    outputSchema: {
      type: 'object',
      properties: {
        result: { type: 'number' }
      }
    },
    implementation: async (params: any) => {
      const { operation, a, b } = params;
      
      switch (operation) {
        case 'add':
          return { result: a + b };
        case 'subtract':
          return { result: a - b };
        case 'multiply':
          return { result: a * b };
        case 'divide':
          if (b === 0) throw new Error('Division by zero');
          return { result: a / b };
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    }
  };
  
  // Register the custom tool
  await agent.registerTool(customTool);
  
  // Use the custom tool
  const conversationId = agent.createConversation();
  const response = await agent.processMessage(
    conversationId,
    'Calculate 15 multiply 4 using the custom calculator'
  );
  
  console.log('Custom tool response:', response.content);
  
  await agent.shutdown();
}

// Example 10: Performance Testing
export async function performanceTestExample() {
  console.log('\n=== Performance Test Example ===');
  
  const agent = await AgenticUtils.createBasicAgent();
  
  // Test response time
  const startTime = Date.now();
  const conversationId = agent.createConversation();
  const response = await agent.processMessage(
    conversationId,
    'What is the speed of light?'
  );
  const endTime = Date.now();
  
  console.log(`Response time: ${endTime - startTime}ms`);
  console.log('Response:', response.content.substring(0, 100) + '...');
  
  // Test multiple concurrent conversations
  const concurrentStart = Date.now();
  const promises = [];
  
  for (let i = 0; i < 5; i++) {
    const conv = agent.createConversation();
    promises.push(agent.processMessage(conv, `Tell me about topic ${i}`));
  }
  
  const results = await Promise.all(promises);
  const concurrentEnd = Date.now();
  
  console.log(`Concurrent processing time: ${concurrentEnd - concurrentStart}ms`);
  console.log(`Average per conversation: ${(concurrentEnd - concurrentStart) / 5}ms`);
  
  await agent.shutdown();
}

// Example 11: Running Tests
export async function runTestsExample() {
  console.log('\n=== Running Tests Example ===');
  
  // Create an agent for testing
  const agent = await AgenticUtils.createBasicAgent();
  
  // Run the comprehensive test suite
  console.log('Running comprehensive tests...');
  await agent.runTests();
  
  await agent.shutdown();
}

// Main example runner
export async function runAllExamples() {
  console.log('🚀 Starting Agentic Framework Examples\n');
  
  try {
    await basicAgentExample();
    await secureAgentExample();
    await developmentAgentExample();
    await customConfigurationExample();
    await streamingResponseExample();
    await directToolExecutionExample();
    await errorHandlingExample();
    await multiConversationExample();
    await customToolExample();
    await performanceTestExample();
    // await runTestsExample(); // Uncomment to run tests
    
    console.log('\n✅ All examples completed successfully!');
  } catch (error) {
    console.error('❌ Error running examples:', error);
  }
}

// Utility function to demonstrate a specific example
export async function runExample(exampleName: string) {
  const examples: Record<string, () => Promise<void>> = {
    'basic': basicAgentExample,
    'secure': secureAgentExample,
    'development': developmentAgentExample,
    'custom': customConfigurationExample,
    'streaming': streamingResponseExample,
    'direct': directToolExecutionExample,
    'error': errorHandlingExample,
    'multi': multiConversationExample,
    'custom-tool': customToolExample,
    'performance': performanceTestExample,
    'tests': runTestsExample
  };
  
  const example = examples[exampleName];
  if (example) {
    await example();
  } else {
    console.log('Available examples:', Object.keys(examples).join(', '));
  }
}

// Export all examples for individual use
export {
  basicAgentExample,
  secureAgentExample,
  developmentAgentExample,
  customConfigurationExample,
  streamingResponseExample,
  directToolExecutionExample,
  errorHandlingExample,
  multiConversationExample,
  customToolExample,
  performanceTestExample,
  runTestsExample
};

// If running this file directly
if (import.meta.main) {
  runAllExamples();
} 