import type { ChatRequest, ChatResponse, StreamCallback, ProviderName, ProviderConfig, MediaAttachment, MediaProcessingResult } from './types.ts';
import { getProvider, isProviderAvailable, getAvailableProviders } from './providers/index.ts';
import { formatMessages, countTokens, createMockResponse, processStream, parseSSEData } from './helpers.ts';
import {
    preprocessMediaAttachments,
    generateMediaSummary,
    getProviderMediaCapabilities,
    validateMedia
} from './media.ts';
import { MODEL_TABLE, queryModels, type ModelRecord, type ModelCapability, type ModelSize } from './model-capabilities.ts';

/**
 * Helper functions using queryModels to replace the removed utility functions
 */

// Get all models for a provider
function getProviderModels(provider: ProviderName): ModelRecord[] {
    return queryModels({ provider });
}

// Get all capabilities supported by a provider
function getProviderCapabilities(provider: ProviderName): ModelCapability[] {
    const models = queryModels({ provider });
    const capabilities: ModelCapability[] = [];
    
    // Check for each capability type
    if (models.some(m => m.reasoning > 0)) capabilities.push('thinking');
    if (models.some(m => m.vision)) capabilities.push('vision');
    if (models.some(m => m.audio)) capabilities.push('audio');
    if (models.some(m => m.imageGen)) capabilities.push('image-gen');
    if (models.some(m => m.audioGen)) capabilities.push('audio-gen');
    
    return capabilities;
}

// Get available sizes for a provider + capability combination
function getAvailableSizes(provider: ProviderName, capability: ModelCapability): ModelSize[] {
    let criteria: Partial<ModelRecord> = { provider };
    
    // Add capability-specific criteria
    switch (capability) {
        case 'thinking':
            // No direct filter needed, we'll filter by reasoning > 0 below
            break;
        case 'vision':
            criteria.vision = true;
            break;
        case 'audio':
            criteria.audio = true;
            break;
        case 'image-gen':
            criteria.imageGen = true;
            break;
        case 'audio-gen':
            criteria.audioGen = true;
            break;
    }
    
    let models = queryModels(criteria);
    
    // Special handling for thinking capability
    if (capability === 'thinking') {
        models = models.filter(m => m.reasoning > 0);
    }
    
    // Get unique sizes in priority order
    const availableSizes = models.map(m => m.size);
    const sizes: ModelSize[] = ['nano', 'small', 'medium', 'large'];
    return sizes.filter(size => availableSizes.includes(size));
}

// Get a model by provider, capability, and size
function getModel(provider: ProviderName, capability: ModelCapability, size: ModelSize): { model: string; reasoningEffort?: string } | null {
    let criteria: Partial<ModelRecord> = { provider, size };
    
    // Add capability-specific criteria
    switch (capability) {
        case 'vision':
            criteria.vision = true;
            break;
        case 'audio':
            criteria.audio = true;
            break;
        case 'image-gen':
            criteria.imageGen = true;
            break;
        case 'audio-gen':
            criteria.audioGen = true;
            break;
        case 'thinking':
            // We'll filter by reasoning > 0 after query
            break;
    }
    
    let models = queryModels(criteria);
    
    // Special handling for thinking capability
    if (capability === 'thinking') {
        models = models.filter(m => m.reasoning > 0);
    }
    
    const model = models[0];
    if (!model) return null;
    
    return {
        model: model.name,
        reasoningEffort: model.reasoningEffort || undefined
    };
}

// Get just the model name
function getModelName(provider: ProviderName, capability: ModelCapability, size: ModelSize): string | null {
    const config = getModel(provider, capability, size);
    return config?.model || null;
}

// Get a comprehensive overview of all available models
function getModelOverview(): Record<ProviderName, Record<ModelCapability, string[]>> {
    const providers: ProviderName[] = ['openai', 'anthropic', 'gemini', 'groq', 'deepseek', 'ollama', 'xai'];
    const capabilities: ModelCapability[] = ['thinking', 'vision', 'audio', 'image-gen', 'audio-gen'];
    
    const overview: any = {};
    
    providers.forEach(provider => {
        overview[provider] = {};
        capabilities.forEach(capability => {
            const sizes = getAvailableSizes(provider, capability);
            overview[provider][capability] = sizes
                .map(size => getModelName(provider, capability, size))
                .filter(Boolean);
        });
    });
    
    return overview;
}

// Smart model selection
function selectModel(requirements: {
    capabilities: ModelCapability[];
    preferredSize?: ModelSize;
    provider?: ProviderName;
    fallbackProvider?: ProviderName[];
}): {
    provider: ProviderName;
    model: string;
    capability: ModelCapability;
    size: ModelSize;
    reasoningEffort?: string;
} | null {
    const { capabilities, preferredSize = 'medium', provider, fallbackProvider = [] } = requirements;
    
    // Determine providers to check
    const providersToCheck = provider 
        ? [provider] 
        : ['openai', 'anthropic', 'gemini', 'groq', 'deepseek', 'ollama', 'xai', ...fallbackProvider];
    
    // For each capability, try to find a model
    for (const capability of capabilities) {
        for (const providerName of providersToCheck) {
            // Try preferred size first, then fall back to best available
            let modelConfig = getModel(providerName as ProviderName, capability, preferredSize);
            let actualSize = preferredSize;
            
            if (!modelConfig) {
                // Try other sizes in order of preference
                const sizes: ModelSize[] = ['large', 'medium', 'small', 'nano'];
                for (const size of sizes) {
                    modelConfig = getModel(providerName as ProviderName, capability, size);
                    if (modelConfig) {
                        actualSize = size;
                        break;
                    }
                }
            }
            
            if (modelConfig) {
                return {
                    provider: providerName as ProviderName,
                    model: modelConfig.model,
                    capability,
                    size: actualSize,
                    reasoningEffort: modelConfig.reasoningEffort
                };
            }
        }
    }
    
    return null;
}

// Display model table for debugging
function displayModelTable(provider?: ProviderName): void {
    const modelsToShow = provider ? queryModels({ provider }) : MODEL_TABLE;
    
    console.log('\n📊 Model Capabilities Table:');
    console.log('| Provider | Model | Size | Vision | Audio | Image-Gen | Audio-Gen | Reasoning | Cost |');
    console.log('|----------|-------|------|--------|-------|-----------|-----------|-----------|------|');
    
    modelsToShow.forEach(model => {
        const vision = model.vision ? '✅' : '❌';
        const audio = model.audio ? '✅' : '❌';
        const imageGen = model.imageGen ? '✅' : '❌';
        const audioGen = model.audioGen ? '✅' : '❌';
        const reasoning = model.reasoning === 0 ? '❌' : `${model.reasoning}/3`;
        const cost = model.costTier || 'unknown';
        
        console.log(
            `| ${model.provider.padEnd(8)} | ${model.name.padEnd(30)} | ${model.size.padEnd(6)} | ${vision.padEnd(6)} | ${audio.padEnd(5)} | ${imageGen.padEnd(9)} | ${audioGen.padEnd(9)} | ${reasoning.padEnd(9)} | ${cost.padEnd(6)} |`
        );
    });
    
    console.log('\n🔍 Legend: ✅ = Supported, ❌ = Not Supported, Numbers = Reasoning Level (0-3)');
}

/**
 * Unified AI Chat endpoint with comprehensive multimodal support
 * Handles text, images, audio, video, and documents across all providers
 * 
 * Provider can be specified via:
 * - Query parameter: ?provider=openai
 * - Request body: { provider: 'openai', ... }
 * - URL path: /api/ai/chat/openai (handled by middleware)
 * - Config object: { config: { provider: 'openai' } }
 */

/**
 * Process media attachments for a provider
 */
async function processMediaAttachments(
    attachments: MediaAttachment[],
    config: ProviderConfig,
    provider: ProviderName,
    providerAPI: any
): Promise<{
    processedAttachments: MediaAttachment[];
    processingResults: MediaProcessingResult[];
}> {
    const capabilities = getProviderMediaCapabilities(provider);
    const processingResults: MediaProcessingResult[] = [];
    const processedAttachments: MediaAttachment[] = [];

    for (const attachment of attachments) {
        // Validate media first
        const validation = validateMedia(attachment);
        if (!validation.valid) {
            processingResults.push({
                success: false,
                type: attachment.type,
                error: validation.error,
                processingTime: 0
            });
            continue;
        }

        // Check if provider supports this media type
        const mediaTypeKey = attachment.type === 'image' ? 'vision'
            : attachment.type === 'document' ? 'documents'
                : attachment.type;

        if (!capabilities[mediaTypeKey as keyof typeof capabilities]) {
            processingResults.push({
                success: false,
                type: attachment.type,
                error: `${provider} does not support ${attachment.type} processing`,
                processingTime: 0
            });
            continue;
        }

        // Process based on type and configuration
        if (attachment.type === 'audio' && config.preprocessing?.autoTranscribe) {
            // Auto-transcribe audio
            if (providerAPI.processMedia?.processAudio) {
                const result = await providerAPI.processMedia.processAudio(attachment, config);
                processingResults.push(result);

                if (result.success && result.result?.transcription) {
                    // Add transcription as a text message
                    processedAttachments.push({
                        ...attachment,
                        format: 'transcription',
                        data: result.result.transcription
                    });
                }
            }
        } else if (attachment.type === 'video' && config.preprocessing?.autoAnalyze) {
            // Auto-analyze video
            if (providerAPI.processMedia?.processVideo) {
                const result = await providerAPI.processMedia.processVideo(attachment, config);
                processingResults.push(result);
            }
        } else if (attachment.type === 'document' && config.preprocessing?.autoExtractText) {
            // Auto-extract text from documents
            if (providerAPI.processMedia?.processDocument) {
                const result = await providerAPI.processMedia.processDocument(attachment, config);
                processingResults.push(result);

                if (result.success && result.result?.extractedText) {
                    // Add extracted text for analysis
                    processedAttachments.push({
                        ...attachment,
                        format: 'analysis',
                        data: result.result.extractedText
                    });
                }
            }
        } else {
            // Keep original attachment for direct processing
            processedAttachments.push(attachment);
        }
    }

    return { processedAttachments, processingResults };
}

/**
 * Core chat logic with comprehensive multimodal support
 */
export async function executeChat(
    request: ChatRequest,
    config: ProviderConfig,
    env: Record<string, string> = {},
    stream?: StreamCallback
): Promise<ChatResponse> {
    // Handle mock responses
    if (request.answer) {
        return createMockResponse(request);
    }

    // Get provider from config or request
    const provider = config.provider || (request as any).provider;
    if (!provider) {
        throw new Error('Provider must be specified in config or request');
    }

    // Merge configurations
    const mergedConfig: ProviderConfig = {
        ...config,
        ...request.config,
        // Environment variables fallback
        apiKey: config.apiKey ||
            env[`${provider.toUpperCase()}_API_KEY`] ||
            env.OPENAI_API_KEY, // Fallback for compatibility
    };

    // Validate API key
    if (!mergedConfig.apiKey && provider !== 'ollama') {
        throw new Error(`API key is required for ${provider}. Set it in config.apiKey or environment variable ${provider.toUpperCase()}_API_KEY`);
    }

    // Get provider API configuration
    const providerFactory = getProvider(provider);
    const providerAPI = providerFactory(mergedConfig);

    // Check provider multimodal capabilities
    const capabilities = getProviderMediaCapabilities(provider);
    console.log(`[${provider}] Multimodal capabilities:`, capabilities);

    // Process messages with media attachments
    let processedMessages = [...request.messages];
    let allProcessingResults: MediaProcessingResult[] = [];

    // Process media attachments in each message
    for (let i = 0; i < processedMessages.length; i++) {
        const message = processedMessages[i];

        if (message.attachments?.length) {
            console.log(`Processing ${message.attachments.length} media attachments for ${provider}`);

            // Preprocess attachments based on provider capabilities
            const preprocessedAttachments = await preprocessMediaAttachments(
                message.attachments,
                mergedConfig,
                provider
            );

            // Process media attachments
            const { processedAttachments, processingResults } = await processMediaAttachments(
                preprocessedAttachments,
                mergedConfig,
                provider,
                providerAPI
            );

            allProcessingResults.push(...processingResults);

            // Update message with processed attachments
            processedMessages[i] = {
                ...message,
                attachments: processedAttachments,
                metadata: {
                    ...message.metadata,
                    mediaProcessed: true,
                    originalSize: message.attachments.reduce((sum, att) => sum + (att.size || 0), 0)
                }
            };

            // Add media summary to message content if requested
            if (request.mediaConfig?.includeMediaSummary) {
                const mediaSummary = generateMediaSummary(message.attachments);
                processedMessages[i].content += `\n\n${mediaSummary}`;
            }
        }
    }

    // Format messages
    const messages = formatMessages({
        ...request,
        messages: processedMessages
    });

    // Transform messages if needed (e.g., Anthropic, Gemini)
    const finalMessages = providerAPI.transformMessages
        ? providerAPI.transformMessages(messages)
        : messages;

    // Make API request
    console.log(`Making ${provider} API request with ${messages.length} messages`);
    const response = await fetch(providerAPI.endpoint, {
        method: 'POST',
        headers: providerAPI.headers(mergedConfig),
        body: JSON.stringify(providerAPI.body(
            Array.isArray(finalMessages) ? finalMessages : messages,
            mergedConfig
        )),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${provider.toUpperCase()} API Error: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error('Failed to get response reader');
    }

    // Handle streaming response
    let fullResponse = '';

    if (providerAPI.processStream) {
        // Use provider-specific stream processor for non-standard streaming formats
        fullResponse = await providerAPI.processStream(reader, stream || (() => { }), providerAPI.extractContent);
    } else {
        // Standard SSE processing for most providers
        fullResponse = await processStream(reader, stream || (() => { }), providerAPI.extractContent);
    }

    // Prepare comprehensive response
    const chatResponse: ChatResponse = {
        prompt: messages,
        answer: fullResponse,
        tokens: countTokens(messages, fullResponse),
        provider,
        model: mergedConfig.model,
    };

    // Add media processing results if any media was processed
    if (allProcessingResults.length > 0) {
        const successCount = allProcessingResults.filter(r => r.success).length;
        const errorCount = allProcessingResults.filter(r => !r.success).length;
        const totalProcessingTime = allProcessingResults.reduce((sum, r) => sum + (r.processingTime || 0), 0);

        chatResponse.mediaProcessing = {
            processedAttachments: allProcessingResults.map((result, index) => ({
                id: `attachment_${index}`,
                type: result.type,
                processingTime: result.processingTime,
                result: result.result,
                error: result.error
            })),
            totalProcessingTime,
            successCount,
            errorCount
        };
    }

    // Add execution metadata
    const responseWithMetadata = {
        ...chatResponse,
        execution: {
            provider,
            timestamp: new Date().toISOString(),
            messageCount: request.messages.length,
            hasAttachments: request.messages.some((m: any) => m.attachments?.length > 0)
        }
    };

    return responseWithMetadata;
}



if (import.meta.main) {
    // Test Suite for LLM Service
    console.log('🧪 Running LLM Service Tests...\n');

    // Test 1: Provider Models
    console.log('1. Testing getProviderModels...');
    try {
        const openaiModels = getProviderModels('openai');
        const anthropicModels = getProviderModels('anthropic');
        console.log(`   ✅ OpenAI models found: ${openaiModels.length}`);
        console.log(`   ✅ Anthropic models found: ${anthropicModels.length}`);
        console.log(`   📝 Sample OpenAI model: ${openaiModels[0]?.name || 'None'}`);
    } catch (error) {
        console.log(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test 2: Provider Capabilities
    console.log('\n2. Testing getProviderCapabilities...');
    try {
        const providers: ProviderName[] = ['openai', 'anthropic', 'gemini', 'groq'];
        providers.forEach(provider => {
            const capabilities = getProviderCapabilities(provider);
            console.log(`   📋 ${provider}: ${capabilities.join(', ') || 'none'}`);
        });
    } catch (error) {
        console.log(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test 3: Available Sizes
    console.log('\n3. Testing getAvailableSizes...');
    try {
        const sizes = getAvailableSizes('openai', 'vision');
        console.log(`   📏 OpenAI vision model sizes: ${sizes.join(', ')}`);
        
        const thinkingSizes = getAvailableSizes('anthropic', 'thinking');
        console.log(`   🧠 Anthropic thinking model sizes: ${thinkingSizes.join(', ')}`);
    } catch (error) {
        console.log(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test 4: Model Selection
    console.log('\n4. Testing getModel...');
    try {
        const visionModel = getModel('openai', 'vision', 'medium');
        console.log(`   👁️  OpenAI vision model: ${visionModel?.model || 'Not found'}`);
        
        const thinkingModel = getModel('anthropic', 'thinking', 'large');
        console.log(`   🧠 Anthropic thinking model: ${thinkingModel?.model || 'Not found'}`);
        console.log(`   🎯 Reasoning effort: ${thinkingModel?.reasoningEffort || 'N/A'}`);
    } catch (error) {
        console.log(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test 5: Smart Model Selection
    console.log('\n5. Testing selectModel...');
    try {
        const selection1 = selectModel({
            capabilities: ['vision', 'thinking'],
            preferredSize: 'large',
            provider: 'anthropic'
        });
        console.log(`   🎯 Selected for vision+thinking: ${selection1?.provider}/${selection1?.model || 'None found'}`);

        const selection2 = selectModel({
            capabilities: ['audio'],
            preferredSize: 'medium'
        });
        console.log(`   🎵 Selected for audio: ${selection2?.provider}/${selection2?.model || 'None found'}`);
    } catch (error) {
        console.log(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test 6: Model Overview
    console.log('\n6. Testing getModelOverview...');
    try {
        const overview = getModelOverview();
        console.log('   📊 Model Overview Summary:');
        Object.entries(overview).forEach(([provider, capabilities]) => {
            const capCount = Object.values(capabilities).flat().filter(Boolean).length;
            console.log(`   📈 ${provider}: ${capCount} total models across capabilities`);
        });
    } catch (error) {
        console.log(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test 7: Provider Availability
    console.log('\n7. Testing provider availability...');
    try {
        const providers: ProviderName[] = ['openai', 'anthropic', 'gemini', 'groq', 'deepseek', 'ollama'];
        providers.forEach(provider => {
            const available = isProviderAvailable(provider);
            console.log(`   ${available ? '✅' : '❌'} ${provider}: ${available ? 'Available' : 'Not available'}`);
        });
        
        const availableProviders = getAvailableProviders();
        console.log(`   🌐 Total available providers: ${availableProviders.length}`);
    } catch (error) {
        console.log(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test 8: Media Capabilities
    console.log('\n8. Testing media capabilities...');
    try {
        const providers: ProviderName[] = ['openai', 'anthropic', 'gemini'];
        providers.forEach(provider => {
            const mediaCapabilities = getProviderMediaCapabilities(provider);
            const supportedTypes = Object.entries(mediaCapabilities)
                .filter(([_, supported]) => supported)
                .map(([type, _]) => type);
            console.log(`   📸 ${provider} media support: ${supportedTypes.join(', ') || 'none'}`);
        });
    } catch (error) {
        console.log(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test 9: Mock Chat Response
    console.log('\n9. Testing mock chat response...');
    try {
        const mockRequest: ChatRequest = {
            messages: [{ role: 'user', content: 'Hello, world!' }],
            answer: 'This is a mock response for testing purposes.'
        };
        
        const mockResponse = createMockResponse(mockRequest);
        console.log(`   🎭 Mock response generated: ${mockResponse.answer?.substring(0, 50)}...`);
        console.log(`   📊 Token count: ${typeof mockResponse.tokens === 'number' ? mockResponse.tokens : 0}`);
    } catch (error) {
        console.log(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test 10: Display Model Table (limited output)
    console.log('\n10. Testing displayModelTable (sample)...');
    try {
        console.log('   📋 Displaying OpenAI models only:');
        displayModelTable('openai');
    } catch (error) {
        console.log(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test 11: End-to-End API Tests
    console.log('\n11. Testing end-to-end API execution...');
    
    const openaiKey = Deno.env.get('DEFAULT_OPENAI_KEY');
    const geminiKey = Deno.env.get('DEFAULT_GEMINI_KEY');
    
    if (!openaiKey && !geminiKey) {
        console.log('   ⚠️  No API keys found. Skipping E2E tests.');
        console.log('   💡 Set DEFAULT_OPENAI_KEY or DEFAULT_GEMINI_KEY to run E2E tests.');
    } else {
        // Test OpenAI E2E
        if (openaiKey) {
            console.log('   🔄 Testing OpenAI E2E...');
            try {
                const openaiRequest: ChatRequest = {
                    messages: [{ 
                        role: 'user', 
                        content: 'Say "Hello from OpenAI!" and nothing else.' 
                    }]
                };
                
                const openaiConfig: ProviderConfig = {
                    provider: 'openai',
                    apiKey: openaiKey,
                    model: 'gpt-4o-mini',
                    temperature: 0,
                    maxTokens: 50
                };
                
                const startTime = Date.now();
                const openaiResponse = await executeChat(openaiRequest, openaiConfig);
                const duration = Date.now() - startTime;
                
                console.log(`   ✅ OpenAI Response: "${openaiResponse.answer?.substring(0, 50)}..."`);
                console.log(`   ⏱️  OpenAI Duration: ${duration}ms`);
                console.log(`   🔢 OpenAI Tokens: ${openaiResponse.tokens}`);
                console.log(`   🏷️  OpenAI Model: ${openaiResponse.model}`);
                
                    } catch (error) {
                console.log(`   ❌ OpenAI E2E Error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        // Test Gemini E2E
        if (geminiKey) {
            console.log('   🔄 Testing Gemini E2E...');
            try {
                const geminiRequest: ChatRequest = {
                    messages: [{ 
                        role: 'user', 
                        content: 'Say "Hello from Gemini!" and nothing else.' 
                    }]
                };
                
                const geminiConfig: ProviderConfig = {
                    provider: 'gemini',
                    apiKey: geminiKey,
                    model: 'gemini-1.5-flash',
                    temperature: 0,
                    maxTokens: 50
                };
                
                const startTime = Date.now();
                const geminiResponse = await executeChat(geminiRequest, geminiConfig);
                const duration = Date.now() - startTime;
                
                console.log(`   ✅ Gemini Response: "${geminiResponse.answer?.substring(0, 50)}..."`);
                console.log(`   ⏱️  Gemini Duration: ${duration}ms`);
                console.log(`   🔢 Gemini Tokens: ${geminiResponse.tokens}`);
                console.log(`   🏷️  Gemini Model: ${geminiResponse.model}`);
                
            } catch (error) {
                console.log(`   ❌ Gemini E2E Error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        // Test Streaming E2E
        if (openaiKey) {
            console.log('   🔄 Testing OpenAI Streaming E2E...');
            try {
                const streamRequest: ChatRequest = {
                    messages: [{ 
                        role: 'user', 
                        content: 'Count from 1 to 5, each number on a new line.' 
                    }]
                };
                
                const streamConfig: ProviderConfig = {
                    provider: 'openai',
                    apiKey: openaiKey,
                    model: 'gpt-4o-mini',
                    temperature: 0,
                    maxTokens: 100,
                    stream: true
                };
                
                let streamedContent = '';
                let chunkCount = 0;
                
                const streamCallback: StreamCallback = (chunk: string) => {
                    streamedContent += chunk;
                    chunkCount++;
                };
                
                const startTime = Date.now();
                const streamResponse = await executeChat(streamRequest, streamConfig, {}, streamCallback);
                const duration = Date.now() - startTime;
                
                console.log(`   ✅ Stream Response: "${streamResponse.answer?.substring(0, 30)}..."`);
                console.log(`   📊 Stream Chunks: ${chunkCount}`);
                console.log(`   ⏱️  Stream Duration: ${duration}ms`);
                console.log(`   🔄 Streamed Content Length: ${streamedContent.length} chars`);
                
            } catch (error) {
                console.log(`   ❌ Streaming E2E Error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        // Test Vision E2E (if supported)
        if (openaiKey) {
            console.log('   🔄 Testing OpenAI Vision E2E...');
            try {
                // Simple base64 1x1 red pixel image for testing
                const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
                
                const visionRequest: ChatRequest = {
                    messages: [{ 
                        role: 'user', 
                        content: 'What color is this image? Just say the color name.',
                        attachments: [{
                            type: 'image',
                            url: testImage,
                            detail: 'low'
                        }]
                    }]
                };
                
                const visionConfig: ProviderConfig = {
                    provider: 'openai',
                    apiKey: openaiKey,
                    model: 'gpt-4o-mini',
                    temperature: 0,
                    maxTokens: 50
                };
                
                const startTime = Date.now();
                const visionResponse = await executeChat(visionRequest, visionConfig);
                const duration = Date.now() - startTime;
                
                console.log(`   ✅ Vision Response: "${visionResponse.answer?.substring(0, 50)}..."`);
                console.log(`   ⏱️  Vision Duration: ${duration}ms`);
                console.log(`   🖼️  Vision Media Processing: ${visionResponse.mediaProcessing ? 'Yes' : 'No'}`);
                
            } catch (error) {
                console.log(`   ❌ Vision E2E Error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        // Test Model Selection E2E
        if (openaiKey || geminiKey) {
            console.log('   🔄 Testing Smart Model Selection E2E...');
            try {
                const selectedModel = selectModel({
                    capabilities: ['vision'],
                    preferredSize: 'medium',
                    provider: openaiKey ? 'openai' : 'gemini'
                });
                
                if (selectedModel) {
                    const selectionRequest: ChatRequest = {
                        messages: [{ 
                            role: 'user', 
                            content: 'Say "Model selection works!" and nothing else.' 
                        }]
                    };
                    
                    const selectionConfig: ProviderConfig = {
                        provider: selectedModel.provider,
                        apiKey: selectedModel.provider === 'openai' ? openaiKey : geminiKey,
                        model: selectedModel.model,
                        temperature: 0,
                        maxTokens: 50
                    };
                    
                    const startTime = Date.now();
                    const selectionResponse = await executeChat(selectionRequest, selectionConfig);
                    const duration = Date.now() - startTime;
                    
                    console.log(`   ✅ Smart Selection: ${selectedModel.provider}/${selectedModel.model}`);
                    console.log(`   ✅ Selection Response: "${selectionResponse.answer?.substring(0, 50)}..."`);
                    console.log(`   ⏱️  Selection Duration: ${duration}ms`);
                } else {
                    console.log('   ⚠️  No suitable model found for smart selection test');
                }
                
            } catch (error) {
                console.log(`   ❌ Smart Selection E2E Error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        console.log('   🎯 E2E tests completed!');
    }

    // Test Summary
    console.log('\n🎉 LLM Service Tests Complete!');
    console.log('   ✅ Unit tests: Model queries, capabilities, selection');
    console.log('   ✅ Integration tests: Provider availability, media support');
    console.log('   ✅ End-to-end tests: Real API calls (if keys available)');
    console.log('   💡 To run E2E tests, set DEFAULT_OPENAI_KEY and/or DEFAULT_GEMINI_KEY');
    console.log('   🚀 Use the exported functions in your application code.\n');
}

// Export commonly used functions for external access
export {
    getProviderModels,
    getProviderCapabilities,
    getAvailableSizes,
    getModel,
    getModelName,
    getModelOverview,
    selectModel,
    displayModelTable
};