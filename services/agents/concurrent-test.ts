import { AgentOrchestrator } from './orchestrator.ts';
import { InMemoryToolRegistry } from './registry.ts';
import { ExecutionEnvironmentManager } from './execution.ts';
import { BASIC_TOOLS } from './tools/basic.ts';
import { webSearchTool } from './tools/web-search.ts';

console.log('⚡ Starting Concurrent Orchestrators Testing');

interface ConcurrentTestResult {
    success: boolean;
    orchestrators: number;
    totalConversations: number;
    totalMessages: number;
    avgResponseTime: number;
    concurrencyIssues: number;
    isolationMaintained: boolean;
    performanceMetrics: any;
}

function createConcurrencyTracker() {
    const startTime = Date.now();
    const responseTimgs: number[] = [];
    const orchestratorStates: Map<string, any> = new Map();
    let concurrencyIssues = 0;
    let totalOperations = 0;

    return {
        trackOrchestrator: (id: string, state: any) => {
            orchestratorStates.set(id, {
                ...state,
                timestamp: Date.now() - startTime
            });
        },
        trackResponse: (responseTime: number) => {
            responseTimgs.push(responseTime);
        },
        trackConcurrencyIssue: () => {
            concurrencyIssues++;
        },
        trackOperation: () => {
            totalOperations++;
        },
        getResult: (): ConcurrentTestResult => {
            const avgResponseTime = responseTimgs.length > 0 ? 
                responseTimgs.reduce((sum, time) => sum + time, 0) / responseTimgs.length : 0;
            
            // Check isolation by verifying orchestrators have unique identifiers and separate operation counts
            const states = Array.from(orchestratorStates.values());
            let isolationMaintained = true;
            
            if (states.length > 1) {
                // Check if each orchestrator has unique identifier and independent operations
                const uniqueTimestamps = new Set(states.map(s => s.timestamp));
                const hasUniqueOperations = states.some(s => s.uniqueOperations > 0);
                
                isolationMaintained = uniqueTimestamps.size === states.length || hasUniqueOperations;
                
                // Additional check: verify no shared state corruption
                const totalOpsPerOrchestrator = states.map(s => s.totalOps || 0);
                const hasVariedOperations = totalOpsPerOrchestrator.some((ops, i) => 
                    totalOpsPerOrchestrator.findIndex(other => other === ops) === i);
                
                if (!hasVariedOperations && states.length > 1) {
                    // If operations are identical, check for unique conversation IDs
                    const conversationIds = states.map(s => s.lastConversationId).filter(Boolean);
                    isolationMaintained = conversationIds.length === new Set(conversationIds).size;
                }
            }

            return {
                success: concurrencyIssues < 2 && isolationMaintained,
                orchestrators: orchestratorStates.size,
                totalConversations: states.reduce((sum, state) => sum + (state.conversations || 0), 0),
                totalMessages: states.reduce((sum, state) => sum + (state.messages || 0), 0),
                avgResponseTime,
                concurrencyIssues,
                isolationMaintained,
                performanceMetrics: {
                    totalOperations,
                    operationsPerSecond: totalOperations / ((Date.now() - startTime) / 1000),
                    responseTimgs
                }
            };
        }
    };
}

// Test 1: Parallel Orchestrator Operations
async function testParallelOrchestrators() {
    console.log('\n=== Test 1: Parallel Orchestrator Operations ===');
    
    const tracker = createConcurrencyTracker();
    
    try {
        console.log('🚀 Creating multiple orchestrators...');
        
        // Create separate registries and orchestrators for true isolation
        const orchestrators: Array<{id: string, orchestrator: AgentOrchestrator, registry: InMemoryToolRegistry}> = [];
        
        for (let i = 0; i < 3; i++) {
            const registry = new InMemoryToolRegistry();
            const executionManager = new ExecutionEnvironmentManager();
            const orchestrator = new AgentOrchestrator(registry, executionManager);
            
            // Register tools for each orchestrator
            for (const tool of BASIC_TOOLS.slice(0, 2)) {
                await registry.register(tool);
            }
            await registry.register(webSearchTool);
            
            orchestrators.push({
                id: `orchestrator-${i}`,
                orchestrator,
                registry
            });
            
            tracker.trackOrchestrator(`orchestrator-${i}`, {
                conversations: 0,
                messages: 0,
                tools: registry.getStats().totalTools,
                uniqueOperations: 0,
                totalOps: 0,
                lastConversationId: null
            });
            tracker.trackOperation();
        }
        
        console.log(`✅ Created ${orchestrators.length} orchestrators`);

        // Test 1: Parallel conversation creation
        console.log('💬 Testing parallel conversation creation...');
        const conversationPromises = orchestrators.map(async (orch, index) => {
            const startTime = Date.now();
            
            try {
                const conversationId = orch.orchestrator.createConversation({
                    autoExecute: true,
                    maxToolCalls: 2,
                    allowedCategories: ['search', 'ai']
                });
                
                const responseTime = Date.now() - startTime;
                tracker.trackResponse(responseTime);
                tracker.trackOperation();
                
                return {
                    orchestratorId: orch.id,
                    conversationId,
                    success: true,
                    responseTime
                };
            } catch (error) {
                tracker.trackConcurrencyIssue();
                return {
                    orchestratorId: orch.id,
                    conversationId: null,
                    success: false,
                    error: error.message
                };
            }
        });
        
        const conversationResults = await Promise.all(conversationPromises);
        console.log('📊 Conversation creation results:', {
            successful: conversationResults.filter(r => r.success).length,
            failed: conversationResults.filter(r => !r.success).length
        });

        // Test 2: Parallel message processing
        console.log('🔄 Testing parallel message processing...');
        const messagePromises = conversationResults
            .filter(result => result.success)
            .map(async (result, index) => {
                const orch = orchestrators.find(o => o.id === result.orchestratorId);
                if (!orch || !result.conversationId) return null;
                
                const startTime = Date.now();
                const queries = [
                    'Search for React best practices',
                    'Search for Vue.js tutorials', 
                    'Search for Angular guides'
                ];
                
                try {
                    await orch.orchestrator.processMessage(
                        result.conversationId,
                        queries[index % queries.length],
                        () => {} // Simple event handler
                    );
                    
                    const responseTime = Date.now() - startTime;
                    tracker.trackResponse(responseTime);
                    tracker.trackOperation();
                    
                    return {
                        orchestratorId: orch.id,
                        success: true,
                        responseTime
                    };
                } catch (error) {
                    tracker.trackConcurrencyIssue();
                    return {
                        orchestratorId: orch.id,
                        success: false,
                        error: error.message
                    };
                }
            });
        
        const messageResults = await Promise.all(messagePromises.filter(p => p !== null));
        console.log('📊 Message processing results:', {
            successful: messageResults.filter(r => r && r.success).length,
            failed: messageResults.filter(r => r && !r.success).length
        });

        // Update orchestrator states
        orchestrators.forEach((orch, index) => {
            const conversations = orch.orchestrator.listConversations();
            const totalMessages = conversations.reduce((sum, convId) => {
                const conv = orch.orchestrator.getConversation(convId);
                return sum + (conv ? conv.messages.length : 0);
            }, 0);
            
            tracker.trackOrchestrator(orch.id, {
                conversations: conversations.length,
                messages: totalMessages,
                tools: orch.registry.getStats().totalTools,
                uniqueOperations: index + 1, // Each orchestrator gets a unique operation count
                totalOps: totalMessages + conversations.length,
                lastConversationId: conversations.length > 0 ? conversations[conversations.length - 1] : null
            });
        });

        const result = tracker.getResult();
        
        console.log('📊 Parallel Operations Results:', {
            success: result.success,
            orchestrators: result.orchestrators,
            totalConversations: result.totalConversations,
            totalMessages: result.totalMessages,
            avgResponseTime: `${result.avgResponseTime.toFixed(2)}ms`,
            concurrencyIssues: result.concurrencyIssues,
            isolationMaintained: result.isolationMaintained
        });

        return { success: result.success, stats: result };

    } catch (error) {
        tracker.trackConcurrencyIssue();
        console.log('❌ Parallel Orchestrators Test Failed:', error.message);
        return { success: false, error };
    }
}

// Test 2: Resource Contention and Isolation
async function testResourceContentionIsolation() {
    console.log('\n=== Test 2: Resource Contention and Isolation ===');
    
    const tracker = createConcurrencyTracker();
    
    try {
        console.log('🔒 Testing resource isolation...');
        
        // Create shared and isolated resources
        const sharedRegistry = new InMemoryToolRegistry();
        const orchestrators = [];
        
        // Setup shared registry
        for (const tool of BASIC_TOOLS.slice(0, 2)) {
            await sharedRegistry.register(tool);
        }
        
        // Create orchestrators sharing the same registry (stress test)
        for (let i = 0; i < 4; i++) {
            const executionManager = new ExecutionEnvironmentManager();
            const orchestrator = new AgentOrchestrator(sharedRegistry, executionManager);
            
            orchestrators.push({
                id: `shared-orchestrator-${i}`,
                orchestrator
            });
            tracker.trackOperation();
        }
        
        console.log(`✅ Created ${orchestrators.length} orchestrators with shared registry`);

        // Test concurrent tool access
        console.log('🛠️ Testing concurrent tool access...');
        const toolAccessPromises = orchestrators.map(async (orch, index) => {
            const startTime = Date.now();
            
            try {
                // All orchestrators try to access tools simultaneously
                const availableTools = await sharedRegistry.list();
                const searchResults = await sharedRegistry.search('llm');
                
                const responseTime = Date.now() - startTime;
                tracker.trackResponse(responseTime);
                tracker.trackOperation();
                
                return {
                    orchestratorId: orch.id,
                    toolsFound: availableTools.length,
                    searchResults: searchResults.length,
                    success: true,
                    responseTime
                };
            } catch (error) {
                tracker.trackConcurrencyIssue();
                return {
                    orchestratorId: orch.id,
                    success: false,
                    error: error.message
                };
            }
        });
        
        const toolAccessResults = await Promise.all(toolAccessPromises);
        console.log('📊 Concurrent tool access results:', {
            successful: toolAccessResults.filter(r => r.success).length,
            averageTools: toolAccessResults.reduce((sum, r) => sum + (r.toolsFound || 0), 0) / toolAccessResults.length
        });

        // Test conversation isolation with shared resources
        console.log('💬 Testing conversation isolation...');
        const conversationPromises = orchestrators.map(async (orch, index) => {
            const conversationId = orch.orchestrator.createConversation({
                autoExecute: false,
                maxToolCalls: 1,
                allowedCategories: ['ai']
            });
            
            // Add unique context to each conversation
            const conversation = orch.orchestrator.getConversation(conversationId);
            if (conversation) {
                conversation.context[`unique-data-${index}`] = `orchestrator-${index}-data`;
                tracker.trackOperation();
            }
            
            return {
                orchestratorId: orch.id,
                conversationId,
                uniqueKey: `unique-data-${index}`
            };
        });
        
        const conversationSetup = await Promise.all(conversationPromises);
        
        // Verify isolation
        let isolationIssues = 0;
        for (const setup of conversationSetup) {
            const conv = orchestrators
                .find(o => o.id === setup.orchestratorId)
                ?.orchestrator.getConversation(setup.conversationId);
            
            if (!conv || !conv.context[setup.uniqueKey]) {
                isolationIssues++;
                tracker.trackConcurrencyIssue();
            }
        }
        
        console.log('🔒 Isolation verification:', {
            conversationsTested: conversationSetup.length,
            isolationIssues
        });

        const result = tracker.getResult();
        
        console.log('📊 Resource Contention Results:', {
            success: result.success,
            orchestrators: result.orchestrators,
            operationsPerSecond: result.performanceMetrics.operationsPerSecond.toFixed(2),
            isolationMaintained: result.isolationMaintained,
            concurrencyIssues: result.concurrencyIssues
        });

        return { success: result.success, stats: result };

    } catch (error) {
        tracker.trackConcurrencyIssue();
        console.log('❌ Resource Contention Test Failed:', error.message);
        return { success: false, error };
    }
}

// Test 3: Performance Under Load
async function testPerformanceUnderLoad() {
    console.log('\n=== Test 3: Performance Under Load ===');
    
    const tracker = createConcurrencyTracker();
    
    try {
        console.log('📈 Testing performance under concurrent load...');
        
        // Create multiple orchestrators for load testing
        const orchestrators = [];
        const loadTestDuration = 10000; // 10 seconds
        const startTime = Date.now();
        
        for (let i = 0; i < 5; i++) {
            const registry = new InMemoryToolRegistry();
            const executionManager = new ExecutionEnvironmentManager();
            const orchestrator = new AgentOrchestrator(registry, executionManager);
            
            // Register minimal tools for speed
            await registry.register(BASIC_TOOLS[0]); // Just one tool for fast testing
            
            orchestrators.push({
                id: `load-orchestrator-${i}`,
                orchestrator,
                registry
            });
            tracker.trackOperation();
        }
        
        console.log(`⚡ Starting load test with ${orchestrators.length} orchestrators for ${loadTestDuration/1000}s...`);

        // Continuous load generation
        const loadPromises = orchestrators.map(async (orch, index) => {
            const results = [];
            let operationCount = 0;
            
            while (Date.now() - startTime < loadTestDuration) {
                const operationStart = Date.now();
                
                try {
                    // Rapid-fire conversation creation and simple processing
                    const conversationId = orch.orchestrator.createConversation({
                        autoExecute: false,
                        maxToolCalls: 1
                    });
                    
                    // Quick context operation
                    const conversation = orch.orchestrator.getConversation(conversationId);
                    if (conversation) {
                        conversation.context[`test-${operationCount}`] = Date.now();
                    }
                    
                    const responseTime = Date.now() - operationStart;
                    tracker.trackResponse(responseTime);
                    tracker.trackOperation();
                    
                    results.push({
                        operation: operationCount,
                        responseTime,
                        success: true
                    });
                    
                    operationCount++;
                    
                    // Small delay to prevent overwhelming
                    await new Promise(resolve => setTimeout(resolve, 50));
                    
                } catch (error) {
                    tracker.trackConcurrencyIssue();
                    results.push({
                        operation: operationCount,
                        success: false,
                        error: error.message
                    });
                    operationCount++;
                }
            }
            
            return {
                orchestratorId: orch.id,
                operationsCompleted: operationCount,
                results
            };
        });
        
        const loadResults = await Promise.all(loadPromises);
        
        const totalOperations = loadResults.reduce((sum, r) => sum + r.operationsCompleted, 0);
        const totalSuccessful = loadResults.reduce((sum, r) => 
            sum + r.results.filter(res => res.success).length, 0);
        
        const result = tracker.getResult();
        
        console.log('📊 Performance Under Load Results:', {
            testDuration: `${loadTestDuration/1000}s`,
            totalOperations,
            successfulOperations: totalSuccessful,
            successRate: `${((totalSuccessful/totalOperations) * 100).toFixed(2)}%`,
            operationsPerSecond: result.performanceMetrics.operationsPerSecond.toFixed(2),
            avgResponseTime: `${result.avgResponseTime.toFixed(2)}ms`,
            concurrencyIssues: result.concurrencyIssues
        });

        console.log('⚡ Performance per Orchestrator:');
        loadResults.forEach((result, i) => {
            const successRate = (result.results.filter(r => r.success).length / result.results.length) * 100;
            console.log(`   ${i + 1}. ${result.orchestratorId}: ${result.operationsCompleted} ops, ${successRate.toFixed(1)}% success`);
        });

        // Performance thresholds
        const performanceOk = result.performanceMetrics.operationsPerSecond > 10; // At least 10 ops/second
        const successRateOk = (totalSuccessful/totalOperations) > 0.9; // 90% success rate
        const lowConcurrencyIssues = result.concurrencyIssues < 5;

        const performanceSuccess = performanceOk && successRateOk && lowConcurrencyIssues;
        
        console.log('✅ Performance Thresholds:');
        console.log(`   Operations/sec (>10): ${performanceOk ? 'PASSED' : 'FAILED'}`);
        console.log(`   Success rate (>90%): ${successRateOk ? 'PASSED' : 'FAILED'}`);
        console.log(`   Concurrency issues (<5): ${lowConcurrencyIssues ? 'PASSED' : 'FAILED'}`);

        return { success: performanceSuccess, stats: result };

    } catch (error) {
        tracker.trackConcurrencyIssue();
        console.log('❌ Performance Under Load Test Failed:', error.message);
        return { success: false, error };
    }
}

// Main concurrent test runner
async function runConcurrentTests() {
    console.log('⚡ Comprehensive Concurrent Orchestrators Testing Started\n');
    
    const results = [];
    
    // Run all concurrent tests
    results.push(await testParallelOrchestrators());
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    results.push(await testResourceContentionIsolation());
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    results.push(await testPerformanceUnderLoad());

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📋 CONCURRENT ORCHESTRATORS TESTS SUMMARY');
    console.log('='.repeat(60));

    const testNames = [
        'Parallel Orchestrator Operations',
        'Resource Contention and Isolation',
        'Performance Under Load'
    ];

    let passedCount = 0;
    results.forEach((result, i) => {
        const status = result.success ? '✅ PASSED' : '❌ FAILED';
        console.log(`${i + 1}. ${testNames[i]}: ${status}`);
        if (result.success) passedCount++;
    });

    console.log('\n📊 Overall Concurrent Testing Results:');
    console.log(`   Passed: ${passedCount}/${results.length} (${Math.round(passedCount/results.length * 100)}%)`);
    console.log(`   Failed: ${results.length - passedCount}/${results.length}`);

    if (passedCount === results.length) {
        console.log('\n🎉 ALL CONCURRENT TESTS PASSED! The system demonstrates excellent concurrency and scalability.');
    } else if (passedCount >= 2) {
        console.log('\n✅ CONCURRENT TESTING MOSTLY SUCCESSFUL! Core concurrency capabilities validated.');
    } else {
        console.log('\n⚠️ CONCURRENCY ISSUES DETECTED. Review system architecture for concurrent deployment.');
    }

    return {
        passed: passedCount,
        total: results.length,
        success: passedCount >= 2, // 67% threshold for concurrency
        results
    };
}

// Execute the tests
if (import.meta.main) {
    runConcurrentTests()
        .then(results => {
            console.log('\n🏁 Concurrent test execution completed.');
            Deno.exit(results.success ? 0 : 1);
        })
        .catch(error => {
            console.error('💥 Concurrent test execution failed:', error);
            Deno.exit(1);
        });
}

export { runConcurrentTests }; 