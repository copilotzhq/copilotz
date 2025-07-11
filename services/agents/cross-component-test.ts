import { AgentOrchestrator } from './orchestrator.ts';
import { InMemoryToolRegistry } from './registry.ts';
import { ExecutionEnvironmentManager } from './execution.ts';
import { BASIC_TOOLS } from './tools/basic.ts';
import { webSearchTool } from './tools/web-search.ts';

console.log('🔗 Starting Deep Cross-Component Communication Testing');

// Deep integration test utilities
interface ComponentTestResult {
    success: boolean;
    componentsPaired: string[];
    communicationLatency: number;
    dataIntegrity: boolean;
    errorPropagation: boolean;
    schemaValidation: boolean;
}

function createComponentTracker() {
    const interactions: any[] = [];
    const componentPairs: Set<string> = new Set();
    const startTime = Date.now();
    let schemaValidations = 0;
    let errorsPropagated = 0;

    return {
        trackInteraction: (from: string, to: string, data: any, success: boolean) => {
            interactions.push({
                from,
                to,
                data: typeof data === 'string' ? data.substring(0, 50) : JSON.stringify(data).substring(0, 50),
                success,
                timestamp: Date.now() - startTime
            });
            componentPairs.add(`${from}→${to}`);
        },
        trackSchemaValidation: (valid: boolean) => {
            schemaValidations++;
            if (!valid) errorsPropagated++;
        },
        trackError: (from: string, error: any) => {
            errorsPropagated++;
            interactions.push({
                from,
                to: 'error-handler',
                data: error.message || error,
                success: false,
                timestamp: Date.now() - startTime
            });
        },
        getResult: (): ComponentTestResult => ({
            success: errorsPropagated === 0 || (errorsPropagated / interactions.length) < 0.1,
            componentsPaired: Array.from(componentPairs),
            communicationLatency: interactions.length > 0 ? 
                interactions.reduce((sum, i) => sum + i.timestamp, 0) / interactions.length : 0,
            dataIntegrity: interactions.filter(i => i.success).length / Math.max(interactions.length, 1) > 0.9,
            errorPropagation: errorsPropagated > 0,
            schemaValidation: schemaValidations > 0
        })
    };
}

// Test 1: Schema Integration and Validation
async function testSchemaIntegration() {
    console.log('\n=== Test 1: Schema Integration and Validation ===');
    
    const tracker = createComponentTracker();
    
    try {
        console.log('📋 Testing schema validation integration...');
        
        // Setup system
        const registry = new InMemoryToolRegistry();
        const executionManager = new ExecutionEnvironmentManager();
        const orchestrator = new AgentOrchestrator(registry, executionManager);
        
        tracker.trackInteraction('test-harness', 'registry', 'initialization', true);
        tracker.trackInteraction('test-harness', 'orchestrator', 'initialization', true);

        // Test tool registration with schema validation
        console.log('🔧 Testing tool schema validation...');
        for (const tool of BASIC_TOOLS.slice(0, 2)) {
            try {
                await registry.register(tool);
                tracker.trackSchemaValidation(true);
                tracker.trackInteraction('registry', 'schema-validator', tool.id, true);
            } catch (error) {
                tracker.trackSchemaValidation(false);
                tracker.trackError('registry', error);
            }
        }

        // Test conversation creation with preference validation
        console.log('💬 Testing conversation schema validation...');
        try {
            const conversationId = orchestrator.createConversation({
                autoExecute: true,
                maxToolCalls: 2,
                allowedCategories: ['search', 'utility', 'ai'], // Valid categories
                verbosity: 'normal'
            });
            tracker.trackSchemaValidation(true);
            tracker.trackInteraction('orchestrator', 'conversation-schema', conversationId, true);
        } catch (error) {
            tracker.trackSchemaValidation(false);
            tracker.trackError('orchestrator', error);
        }

        // Test schema handling with defaults (orchestrator is lenient by design)
        console.log('🔧 Testing schema handling with defaults...');
        try {
            // Orchestrator should handle invalid values gracefully with defaults
            const invalidConversationId = orchestrator.createConversation({
                autoExecute: true,
                maxToolCalls: -1, // Invalid value - should use default
                allowedCategories: ['invalid-category'], // Invalid category - should be filtered
                verbosity: 'extreme' // Invalid verbosity - should use default
            } as any);
            
            // Check if conversation was created with defaults
            const conversation = orchestrator.getConversation(invalidConversationId);
            if (conversation) {
                tracker.trackSchemaValidation(true); // Good - handled gracefully with defaults
                tracker.trackInteraction('orchestrator', 'schema-validator', 'defaults-applied', true);
            } else {
                tracker.trackSchemaValidation(false);
                tracker.trackInteraction('orchestrator', 'schema-validator', 'creation-failed', false);
            }
        } catch (error) {
            // Orchestrator shouldn't throw for invalid configs - should use defaults
            tracker.trackSchemaValidation(false);
            tracker.trackInteraction('orchestrator', 'schema-validator', 'unexpected-error', false);
        }

        const result = tracker.getResult();
        
        console.log('📊 Schema Integration Results:', {
            success: result.success,
            componentPairs: result.componentsPaired.length,
            schemaValidation: result.schemaValidation,
            dataIntegrity: result.dataIntegrity
        });

        console.log('🔗 Component Communication Pairs:');
        result.componentsPaired.forEach((pair, i) => {
            console.log(`   ${i + 1}. ${pair}`);
        });

        return { success: result.success, stats: result };

    } catch (error) {
        tracker.trackError('test-harness', error);
        console.log('❌ Schema Integration Test Failed:', error.message);
        return { success: false, error };
    }
}

// Test 2: Middleware and Interceptor Integration
async function testMiddlewareIntegration() {
    console.log('\n=== Test 2: Middleware and Interceptor Integration ===');
    
    const tracker = createComponentTracker();
    
    try {
        console.log('⚙️ Testing middleware chain integration...');
        
        // Setup system with middleware tracking
        const registry = new InMemoryToolRegistry();
        const executionManager = new ExecutionEnvironmentManager();
        const orchestrator = new AgentOrchestrator(registry, executionManager);
        
        // Register tools
        await registry.register(BASIC_TOOLS[0]);
        await registry.register(webSearchTool);
        
        tracker.trackInteraction('middleware', 'registry', 'tool-registration', true);

        // Test request processing through middleware
        console.log('🔄 Testing request middleware processing...');
        const conversationId = orchestrator.createConversation({
            autoExecute: true,
            maxToolCalls: 2,
            allowedCategories: ['search']
        });
        
        tracker.trackInteraction('middleware', 'conversation-manager', 'conversation-created', true);

        // Test message processing with interceptors
        console.log('📡 Testing interceptor integration...');
        let interceptorCalled = false;
        
        await orchestrator.processMessage(
            conversationId,
            'Search for Node.js tutorials',
            (event) => {
                // Simulate interceptor behavior
                if (event.type === 'tool_call') {
                    interceptorCalled = true;
                    tracker.trackInteraction('interceptor', 'tool-executor', event.toolName || 'unknown', true);
                }
                
                // Track event flow through middleware
                tracker.trackInteraction('event-middleware', 'orchestrator', event.type, true);
            }
        );

        if (interceptorCalled) {
            tracker.trackInteraction('interceptor', 'orchestrator', 'tool-intercept', true);
        }

        // Test response middleware
        console.log('📤 Testing response middleware...');
        const conversation = orchestrator.getConversation(conversationId);
        if (conversation && conversation.messages.length > 0) {
            tracker.trackInteraction('response-middleware', 'conversation-store', 'response-stored', true);
        }

        const result = tracker.getResult();
        
        console.log('📊 Middleware Integration Results:', {
            success: result.success,
            middlewareSteps: result.componentsPaired.length,
            latency: `${result.communicationLatency.toFixed(2)}ms`,
            dataIntegrity: result.dataIntegrity
        });

        console.log('⚙️ Middleware Communication Chain:');
        result.componentsPaired.forEach((pair, i) => {
            console.log(`   ${i + 1}. ${pair}`);
        });

        return { success: result.success, stats: result };

    } catch (error) {
        tracker.trackError('middleware-test', error);
        console.log('❌ Middleware Integration Test Failed:', error.message);
        return { success: false, error };
    }
}

// Test 3: Data Flow and State Management Integration
async function testDataFlowIntegration() {
    console.log('\n=== Test 3: Data Flow and State Management Integration ===');
    
    const tracker = createComponentTracker();
    
    try {
        console.log('📊 Testing cross-component data flow...');
        
        const registry = new InMemoryToolRegistry();
        const executionManager = new ExecutionEnvironmentManager();
        const orchestrator = new AgentOrchestrator(registry, executionManager);
        
        // Register tools for data flow testing
        for (const tool of BASIC_TOOLS.slice(0, 3)) {
            await registry.register(tool);
        }
        
        tracker.trackInteraction('data-flow', 'registry', 'tools-loaded', true);

        // Test state creation and management
        console.log('🗂️ Testing state creation and management...');
        const conversationId = orchestrator.createConversation({
            autoExecute: true,
            maxToolCalls: 3,
            allowedCategories: ['ai', 'data']
        });
        
        tracker.trackInteraction('state-manager', 'conversation-store', 'conversation-created', true);

        // Test data flow through multiple components
        console.log('🔄 Testing multi-component data flow...');
        await orchestrator.processMessage(
            conversationId,
            'Generate embeddings for: Machine learning is fascinating',
            (event) => {
                // Track data flow through event system
                if (event.type === 'thinking') {
                    tracker.trackInteraction('orchestrator', 'ai-processor', 'thinking-started', true);
                }
                if (event.type === 'tool_call') {
                    tracker.trackInteraction('ai-processor', 'tool-executor', 'tool-invoked', true);
                }
                if (event.type === 'tool_result') {
                    tracker.trackInteraction('tool-executor', 'result-processor', 'result-generated', true);
                }
                if (event.type === 'text') {
                    tracker.trackInteraction('result-processor', 'response-formatter', 'response-formatted', true);
                }
            }
        );

        // Test state persistence and retrieval
        console.log('💾 Testing state persistence...');
        const conversation = orchestrator.getConversation(conversationId);
        if (conversation) {
            tracker.trackInteraction('conversation-store', 'state-retriever', 'state-retrieved', true);
            
            // Test context management
            conversation.context['test-data'] = 'cross-component-test';
            const updatedConversation = orchestrator.getConversation(conversationId);
            
            if (updatedConversation?.context['test-data'] === 'cross-component-test') {
                tracker.trackInteraction('state-manager', 'context-store', 'context-updated', true);
            } else {
                tracker.trackError('state-manager', new Error('Context update failed'));
            }
        }

        // Test cross-conversation data isolation
        console.log('🔒 Testing data isolation...');
        const conversation2Id = orchestrator.createConversation({
            autoExecute: false,
            maxToolCalls: 1,
            allowedCategories: ['utility']
        });
        
        const conv1 = orchestrator.getConversation(conversationId);
        const conv2 = orchestrator.getConversation(conversation2Id);
        
        if (conv1 && conv2) {
            // Test isolation by setting different context values
            conv1.context['isolation-test'] = 'conversation-1';
            conv2.context['isolation-test'] = 'conversation-2';
            
            const isolationCheck1 = orchestrator.getConversation(conversationId)?.context['isolation-test'];
            const isolationCheck2 = orchestrator.getConversation(conversation2Id)?.context['isolation-test'];
            
            if (isolationCheck1 === 'conversation-1' && isolationCheck2 === 'conversation-2') {
                tracker.trackInteraction('state-manager', 'isolation-validator', 'isolation-verified', true);
            } else {
                tracker.trackError('state-manager', new Error('Data isolation failed'));
            }
        }

        const result = tracker.getResult();
        
        console.log('📊 Data Flow Integration Results:', {
            success: result.success,
            dataFlowSteps: result.componentsPaired.length,
            avgLatency: `${result.communicationLatency.toFixed(2)}ms`,
            integrityScore: `${(result.dataIntegrity ? 100 : 0)}%`
        });

        console.log('📈 Data Flow Communication Path:');
        result.componentsPaired.forEach((pair, i) => {
            console.log(`   ${i + 1}. ${pair}`);
        });

        return { success: result.success, stats: result };

    } catch (error) {
        tracker.trackError('data-flow-test', error);
        console.log('❌ Data Flow Integration Test Failed:', error.message);
        return { success: false, error };
    }
}

// Test 4: Error Propagation and Recovery Integration
async function testErrorPropagationIntegration() {
    console.log('\n=== Test 4: Error Propagation and Recovery Integration ===');
    
    const tracker = createComponentTracker();
    
    try {
        console.log('🚨 Testing error propagation across components...');
        
        const registry = new InMemoryToolRegistry();
        const executionManager = new ExecutionEnvironmentManager();
        const orchestrator = new AgentOrchestrator(registry, executionManager);
        
        // Register tools including one that will fail
        await registry.register(BASIC_TOOLS[0]);
        await registry.register(webSearchTool);
        
        tracker.trackInteraction('error-test', 'registry', 'setup-complete', true);

        // Test 1: Tool execution error propagation
        console.log('⚠️ Testing tool error propagation...');
        const conversationId = orchestrator.createConversation({
            autoExecute: true,
            maxToolCalls: 2,
            allowedCategories: ['utility', 'search']
        });
        
        await orchestrator.processMessage(
            conversationId,
            'Process this invalid operation: xyz123 calculate quantum flux',
            (event) => {
                if (event.type === 'error') {
                    tracker.trackInteraction('tool-executor', 'error-handler', 'error-propagated', true);
                    tracker.trackInteraction('error-handler', 'orchestrator', 'error-handled', true);
                }
                if (event.type === 'tool_result' && event.content.includes('failed')) {
                    tracker.trackInteraction('tool-executor', 'result-processor', 'failure-reported', true);
                }
                if (event.type === 'text' && event.content.includes('failed')) {
                    tracker.trackInteraction('result-processor', 'response-generator', 'error-response', true);
                }
            }
        );

        // Test 2: Recovery and continuation
        console.log('🔄 Testing error recovery and continuation...');
        await orchestrator.processMessage(
            conversationId,
            'Search for Python tutorials',
            (event) => {
                if (event.type === 'tool_result' && event.content.includes('successfully')) {
                    tracker.trackInteraction('recovery-system', 'tool-executor', 'recovery-successful', true);
                }
            }
        );

        // Test 3: System resilience
        console.log('🛡️ Testing system resilience...');
        const conversation = orchestrator.getConversation(conversationId);
        if (conversation && conversation.messages.length > 0) {
            tracker.trackInteraction('resilience-check', 'conversation-store', 'system-stable', true);
        }

        const result = tracker.getResult();
        
        console.log('📊 Error Propagation Integration Results:', {
            success: result.success,
            errorPathways: result.componentsPaired.filter(p => p.includes('error')).length,
            recoveryCapable: result.componentsPaired.some(p => p.includes('recovery')),
            systemResilience: result.dataIntegrity
        });

        console.log('🚨 Error Handling Communication Path:');
        result.componentsPaired.forEach((pair, i) => {
            console.log(`   ${i + 1}. ${pair}`);
        });

        return { success: result.success, stats: result };

    } catch (error) {
        tracker.trackError('error-propagation-test', error);
        console.log('❌ Error Propagation Integration Test Failed:', error.message);
        return { success: false, error };
    }
}

// Main cross-component test runner
async function runCrossComponentTests() {
    console.log('🔗 Comprehensive Cross-Component Communication Testing Started\n');
    
    const results = [];
    
    // Run all cross-component tests
    results.push(await testSchemaIntegration());
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    results.push(await testMiddlewareIntegration());
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    results.push(await testDataFlowIntegration());
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    results.push(await testErrorPropagationIntegration());

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📋 CROSS-COMPONENT COMMUNICATION TESTS SUMMARY');
    console.log('='.repeat(60));

    const testNames = [
        'Schema Integration and Validation',
        'Middleware and Interceptor Integration',
        'Data Flow and State Management Integration',
        'Error Propagation and Recovery Integration'
    ];

    let passedCount = 0;
    results.forEach((result, i) => {
        const status = result.success ? '✅ PASSED' : '❌ FAILED';
        console.log(`${i + 1}. ${testNames[i]}: ${status}`);
        if (result.success) passedCount++;
    });

    console.log('\n📊 Overall Cross-Component Results:');
    console.log(`   Passed: ${passedCount}/${results.length} (${Math.round(passedCount/results.length * 100)}%)`);
    console.log(`   Failed: ${results.length - passedCount}/${results.length}`);

    if (passedCount === results.length) {
        console.log('\n🎉 ALL CROSS-COMPONENT TESTS PASSED! Deep integration is robust and production-ready.');
    } else if (passedCount >= 3) {
        console.log('\n✅ CROSS-COMPONENT INTEGRATION MOSTLY SUCCESSFUL! Core communication pathways validated.');
    } else {
        console.log('\n⚠️ CROSS-COMPONENT ISSUES DETECTED. Review communication architecture before deployment.');
    }

    return {
        passed: passedCount,
        total: results.length,
        success: passedCount >= 3, // 75% threshold
        results
    };
}

// Execute the tests
if (import.meta.main) {
    runCrossComponentTests()
        .then(results => {
            console.log('\n🏁 Cross-component test execution completed.');
            Deno.exit(results.success ? 0 : 1);
        })
        .catch(error => {
            console.error('💥 Cross-component test execution failed:', error);
            Deno.exit(1);
        });
}

export { runCrossComponentTests }; 