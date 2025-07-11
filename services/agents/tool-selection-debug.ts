#!/usr/bin/env deno run -A --env

import { ToolExecutionPlanner } from './orchestrator.ts';
import { InMemoryToolRegistry } from './registry.ts';
import { ExecutionEnvironmentManager } from './execution.ts';
import { BASIC_TOOLS } from './tools/basic.ts';
import { httpApiTool } from './tools/api.ts';
import { webSearchTool } from './tools/web-search.ts';

console.log('🔍 Debugging Tool Selection Logic...\n');

// Setup registry
const registry = new InMemoryToolRegistry();
const executionManager = new ExecutionEnvironmentManager();

// Register tools
for (const tool of BASIC_TOOLS) {
  await registry.register(tool);
}
await registry.register(httpApiTool);
await registry.register(webSearchTool);

// Create planner
const planner = new ToolExecutionPlanner(registry, executionManager);

console.log('📋 Available Tools:');
const allTools = await registry.list();
allTools.forEach(tool => {
  console.log(`   • ${tool.id} (${tool.category}) - ${tool.name}`);
});

console.log('\n' + '='.repeat(60));

// Test 1: Debug Intent Analysis
console.log('🔄 Test 1: Intent Analysis');

const queries = [
  "What is 2 + 2?",
  "Search for information about AI", 
  "Make an API call to get weather data",
  "Convert text to uppercase"
];

for (const query of queries) {
  console.log(`\n📝 Query: "${query}"`);
  
  // Use the planner's private method by accessing it through reflection
  const intent = (planner as any).analyzeIntent(query);
  console.log(`   🎯 Intent: ${JSON.stringify(intent)}`);
  
  // Test different category preferences
  const testPreferences = [
    { allowedCategories: ['core', 'search', 'utility'] },
    { allowedCategories: ['knowledge', 'ai', 'function'] },
    { allowedCategories: ['api', 'web_search', 'utility'] },
    { allowedCategories: ['knowledge', 'search', 'utility', 'ai', 'function', 'api', 'web_search'] }
  ];
  
  for (const prefs of testPreferences) {
    const relevantTools = await (planner as any).getRelevantTools(intent, prefs);
    console.log(`   📊 Categories [${prefs.allowedCategories.join(', ')}]: ${relevantTools.length} tools found`);
    
    if (relevantTools.length > 0) {
      relevantTools.forEach(tool => {
        console.log(`      • ${tool.id} (${tool.category})`);
      });
    }
  }
}

console.log('\n' + '='.repeat(60));

// Test 2: Registry Search Testing
console.log('🔄 Test 2: Registry Search Testing');

const testSearches = [
  "math calculate",
  "search web",
  "api http",
  "text processing",
  "2 + 2",
  "artificial intelligence"
];

for (const searchQuery of testSearches) {
  console.log(`\n🔍 Search: "${searchQuery}"`);
  
  // Test searches with different categories
  const categories = ['knowledge', 'ai', 'function', 'api', 'web_search', undefined];
  
  for (const category of categories) {
    try {
      const results = await registry.search(searchQuery, {
        category: category as any,
        limit: 5
      });
      console.log(`   📊 Category "${category}": ${results.length} tools`);
      results.forEach(tool => {
        console.log(`      • ${tool.id} (${tool.category})`);
      });
    } catch (error) {
      console.log(`   ❌ Category "${category}": ${error.message}`);
    }
  }
}

console.log('\n' + '='.repeat(60));

// Test 3: Full Execution Plan
console.log('🔄 Test 3: Full Execution Plan Test');

const context = {};
const preferences = {
  verbosity: 'normal' as const,
  autoExecute: true,
  maxToolCalls: 3,
  safetyLevel: 'medium' as const,
  allowedCategories: ['knowledge', 'ai', 'function', 'api', 'web_search'],
  preferredTools: []
};

for (const query of ["What is 2 + 2?", "Search for artificial intelligence"]) {
  console.log(`\n📝 Planning: "${query}"`);
  
  try {
    const plan = await planner.planExecution(query, context, preferences);
    console.log(`   🎯 Plan: ${plan.toolCalls.length} tool calls`);
    console.log(`   🧠 Reasoning: ${plan.reasoning}`);
    console.log(`   📊 Confidence: ${plan.confidence}`);
    
    plan.toolCalls.forEach((call, i) => {
      console.log(`   ${i + 1}. ${call.toolId} (priority: ${call.priority})`);
      console.log(`      Params: ${JSON.stringify(call.parameters)}`);
      console.log(`      Reason: ${call.reason}`);
    });
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
  }
}

console.log('\n🎉 Tool Selection Debug Complete!'); 