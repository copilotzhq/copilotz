#!/usr/bin/env deno run -A --env

import { AgentOrchestrator, ToolExecutionPlanner } from './orchestrator.ts';
import { InMemoryToolRegistry } from './registry.ts';
import { ExecutionEnvironmentManager } from './execution.ts';

console.log('🔍 Debugging Context Management Failures...\n');

// Setup minimal test environment
const registry = new InMemoryToolRegistry();
const executionManager = new ExecutionEnvironmentManager();

// Create simple memory tool
const memoryTool = {
  id: 'memory-store',
  name: 'Memory Storage',
  description: 'Store and recall conversation information and personal details',
  type: 'function' as const,
  category: 'utility',
  version: '1.0.0',
  
  execution: {
    environment: 'direct' as const,
    timeout: 5000
  },
  
  input: {
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        key: { type: 'string' },
        value: { type: 'string' },
        query: { type: 'string' }
      }
    },
    required: ['action']
  },
  
  output: {
    schema: {
      type: 'object',
      properties: {
        result: { type: 'string' }
      }
    }
  },
  
  implementation: {
    type: 'function' as const,
    handler: async (input: any) => {
      console.log(`🧠 [MEMORY-DEBUG] Called with:`, input);
      
      return {
        success: true,
        result: `Memory operation: ${input.action || 'unknown'}`
      };
    }
  },
  
  permissions: {
    networkAccess: false,
    fileSystemAccess: false,
    requiresAuthentication: false
  },
  
  metadata: {
    author: 'Test',
    tags: ['memory', 'storage', 'context', 'recall', 'personal', 'information']
  }
};

await registry.register(memoryTool);

const orchestrator = new AgentOrchestrator(registry, executionManager);
const planner = new ToolExecutionPlanner(registry, executionManager);

console.log('🔧 Available tools:');
const tools = await registry.list();
tools.forEach(tool => {
  console.log(`   • ${tool.id} (${tool.category}) - ${tool.name}`);
  console.log(`     Keywords: ${tool.metadata.tags.join(', ')}`);
});

console.log('\n' + '='.repeat(60));

// Test 1: Intent Analysis Debug
console.log('🔄 Test 1: Intent Analysis for Context Queries');

const contextQueries = [
  "My name is Alice",
  "I'm a software engineer", 
  "What did I tell you about my profession?",
  "What's my name?",
  "Remember that I like pizza"
];

for (const query of contextQueries) {
  console.log(`\n📝 Query: "${query}"`);
  
  // Access private method to debug intent analysis
  const intent = (planner as any).analyzeIntent(query);
  console.log(`   🎯 Intent: type="${intent.type}", keywords=[${intent.keywords.join(', ')}]`);
  
  // Test tool selection with different category preferences
  const preferences = {
    allowedCategories: ['utility', 'memory', 'storage'],
    maxToolCalls: 2,
    verbosity: 'normal' as const,
    autoExecute: true,
    safetyLevel: 'medium' as const,
    preferredTools: ['memory-store']
  };
  
  const relevantTools = await (planner as any).getRelevantTools(intent, preferences);
  console.log(`   🛠️ Selected tools: ${relevantTools.map(t => t.id).join(', ')}`);
  
  if (relevantTools.length > 0) {
    for (const tool of relevantTools) {
      const priority = (planner as any).calculatePriority(tool, intent);
      console.log(`      • ${tool.id}: priority=${priority.toFixed(2)}`);
    }
  }
}

console.log('\n' + '-'.repeat(40) + '\n');

// Test 2: Parameter Generation Debug
console.log('🔄 Test 2: Parameter Generation for Memory Tool');

const memoryQueries = [
  { query: "My name is Alice", expectedAction: "store", expectedKey: "name", expectedValue: "Alice" },
  { query: "What's my name?", expectedAction: "recall", expectedKey: "name" },
  { query: "I work in San Francisco", expectedAction: "store", expectedKey: "location", expectedValue: "San Francisco" }
];

for (const test of memoryQueries) {
  console.log(`\n📝 Query: "${test.query}"`);
  console.log(`   🎯 Expected: action="${test.expectedAction}", key="${test.expectedKey}"`);
  
  const intent = (planner as any).analyzeIntent(test.query);
  const tool = await registry.get('memory-store');
  
  if (tool) {
    const parameters = await (planner as any).generateParameters(tool, intent, {});
    console.log(`   ⚙️ Generated params:`, parameters);
    
    // Check if parameters match expectations
    const hasAction = parameters && parameters.action === test.expectedAction;
    const hasKey = parameters && parameters.key === test.expectedKey;
    console.log(`   ✅ Params valid: ${hasAction && hasKey ? 'YES' : 'NO'}`);
  }
}

console.log('\n' + '-'.repeat(40) + '\n');

// Test 3: Full Execution Plan Debug
console.log('🔄 Test 3: Full Execution Plan for Context');

const conversationId = orchestrator.createConversation({
  verbosity: 'detailed',
  autoExecute: false, // Just planning, no execution
  maxToolCalls: 3,
  allowedCategories: ['utility', 'memory', 'storage'],
  preferredTools: ['memory-store']
});

const planQueries = [
  "My name is Alice and I'm a software engineer",
  "What did I tell you about my profession?"
];

for (const query of planQueries) {
  console.log(`\n📝 Planning for: "${query}"`);
  
  try {
    const response = await orchestrator.processMessage(conversationId, query);
    console.log(`   📋 Plan: ${response.content.substring(0, 120)}...`);
    
    // Check if any tools were planned
    const conversation = orchestrator.getConversation(conversationId);
    const lastMessage = conversation?.messages[conversation.messages.length - 1];
    
    if (lastMessage?.toolCalls && lastMessage.toolCalls.length > 0) {
      console.log(`   🛠️ Planned tools: ${lastMessage.toolCalls.length}`);
      lastMessage.toolCalls.forEach((call, i) => {
        console.log(`      ${i + 1}. ${call.toolId}: ${JSON.stringify(call.parameters)}`);
      });
    } else {
      console.log(`   ❌ No tools planned!`);
    }
    
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
  }
}

console.log('\n' + '-'.repeat(40) + '\n');

// Test 4: Context Manager Debug
console.log('🔄 Test 4: Context Manager Functionality');

const contextId = orchestrator.createConversation();

// Test context manager directly
console.log('   🧠 Testing context manager...');

const conversation = orchestrator.getConversation(contextId);
if (conversation) {
  console.log(`   📊 Initial context keys: ${Object.keys(conversation.context).length}`);
  
  // Try to update context manually
  const contextManager = (orchestrator as any).contextManager;
  contextManager.updateContext(contextId, { 
    name: 'Alice',
    profession: 'software engineer',
    test: 'manual update'
  });
  
  const updatedConversation = orchestrator.getConversation(contextId);
  console.log(`   📊 After manual update: ${Object.keys(updatedConversation?.context || {}).length} keys`);
  console.log(`   📋 Context content:`, updatedConversation?.context);
  
  // Test context retrieval
  const retrievedContext = contextManager.getContext(contextId);
  console.log(`   🔍 Retrieved context:`, retrievedContext);
}

console.log('\n' + '='.repeat(60));
console.log('🎉 Context Debug Complete!');

console.log('\n🚨 Issues Found:');
console.log('   1. Intent classification for memory operations');
console.log('   2. Parameter generation for memory actions');  
console.log('   3. Tool priority calculation for context tools');
console.log('   4. Context manager integration'); 