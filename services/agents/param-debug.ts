#!/usr/bin/env deno run -A --env

import { ToolExecutionPlanner } from './orchestrator.ts';
import { InMemoryToolRegistry } from './registry.ts';
import { ExecutionEnvironmentManager } from './execution.ts';

console.log('🔍 Debugging Parameter Generation...\n');

// Setup
const registry = new InMemoryToolRegistry();
const executionManager = new ExecutionEnvironmentManager();

// Create memory tool
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
      return { success: true, result: 'test' };
    }
  },
  
  permissions: {
    networkAccess: false,
    fileSystemAccess: false,
    requiresAuthentication: false
  },
  
  metadata: {
    author: 'Test',
    tags: ['memory', 'storage', 'context']
  }
};

await registry.register(memoryTool);
const planner = new ToolExecutionPlanner(registry, executionManager);

console.log('🔧 Tool Schema Analysis:');
const tool = await registry.get('memory-store');
if (tool) {
  console.log('   Tool ID:', tool.id);
  console.log('   Tool Category:', tool.category);
  console.log('   Tool Name:', tool.name);
  console.log('   Has inputSchema:', !!tool.inputSchema);
  console.log('   InputSchema:', JSON.stringify(tool.inputSchema, null, 2));
  console.log('   Schema Properties:', tool.inputSchema?.properties ? Object.keys(tool.inputSchema.properties) : 'undefined');
}

console.log('\n' + '='.repeat(60));

// Test parameter generation step by step
console.log('🔄 Step-by-Step Parameter Generation:');

const testQuery = "My name is Alice";
console.log(`\n📝 Query: "${testQuery}"`);

// Step 1: Intent analysis
const intent = (planner as any).analyzeIntent(testQuery);
console.log('   1. Intent:', JSON.stringify(intent));

// Step 2: Check tool matching conditions
console.log('\n   2. Tool Matching Conditions:');
console.log(`      tool.id.includes('memory'): ${tool?.id.includes('memory')}`);
console.log(`      tool.category === 'utility': ${tool?.category === 'utility'}`);
console.log(`      tool.name.toLowerCase().includes('memory'): ${tool?.name.toLowerCase().includes('memory')}`);

// Step 3: Check schema properties
console.log('\n   3. Schema Properties Check:');
if (tool?.inputSchema?.properties) {
  console.log(`      'action' in properties: ${'action' in tool.inputSchema.properties}`);
  console.log(`      'key' in properties: ${'key' in tool.inputSchema.properties}`);
  console.log(`      'value' in properties: ${'value' in tool.inputSchema.properties}`);
  console.log(`      'query' in properties: ${'query' in tool.inputSchema.properties}`);
}

// Step 4: Check intent keywords
console.log('\n   4. Intent Keywords Analysis:');
console.log(`      Keywords: [${intent.keywords.join(', ')}]`);
console.log(`      Has 'name': ${intent.keywords.includes('name')}`);
console.log(`      Has recall words: ${intent.keywords.some(k => ['what', 'tell', 'recall', 'remember', 'said'].includes(k.toLowerCase()))}`);

// Step 5: Manual parameter generation
console.log('\n   5. Manual Parameter Generation:');
const parameters: Record<string, any> = {};

if (tool?.inputSchema?.properties) {
  // Check memory tool condition
  const isMemoryTool = tool.id.includes('memory') || (tool.category === 'utility' && tool.name.toLowerCase().includes('memory'));
  console.log(`      Is Memory Tool: ${isMemoryTool}`);
  
  if (isMemoryTool && 'action' in tool.inputSchema.properties) {
    console.log('      Entering memory tool logic...');
    
    // Check for recall vs store
    const isRecall = intent.keywords.some(k => ['what', 'tell', 'recall', 'remember', 'said'].includes(k.toLowerCase()));
    console.log(`      Is Recall Query: ${isRecall}`);
    
    if (isRecall) {
      parameters.action = 'recall';
      console.log('      Set action = recall');
    } else {
      parameters.action = 'store';
      console.log('      Set action = store');
      
      if (intent.keywords.includes('name')) {
        parameters.key = 'name';
        const query = intent.keywords.join(' ');
        const nameMatch = query.match(/(?:name is|i'm|called)\s+(\w+)/i);
        if (nameMatch) parameters.value = nameMatch[1];
        console.log(`      Set key = name, value = ${parameters.value || 'undefined'}`);
      }
    }
  }
}

console.log('   6. Final Parameters:', JSON.stringify(parameters));

// Step 6: Test actual generateParameters method
console.log('\n   7. Actual generateParameters Result:');
const actualParams = await (planner as any).generateParameters(tool, intent, {});
console.log('      Result:', JSON.stringify(actualParams));

console.log('\n' + '='.repeat(60));
console.log('🎉 Parameter Debug Complete!'); 