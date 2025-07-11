import { ai, chat, embed, speak, generateImage } from '../../services/ai/index.ts';
import type { AIRequest, LLMResponse, EmbeddingResponse, SpeechToTextResponse, TextToSpeechResponse, ImageGenerationResponse } from '../../services/ai/types.ts';

/**
 * Unified AI Endpoint using Oxian-js Framework
 * Supports all AI service types: LLM, Embeddings, STT, TTS, Image Generation
 * 
 * Usage:
 * POST /features/ai - Unified AI interface (specify type in body)
 * GET /features/ai?type=chat&message=Hello - Quick chat
 * GET /features/ai?type=embed&text=Hello - Quick embedding
 * 
 * Provider Examples:
 * - OpenAI: { provider: 'openai', model: 'gpt-4o-mini' }
 * - Gemini: { provider: 'gemini', model: 'gemini-1.5-flash' }  
 * - Anthropic: { provider: 'anthropic', model: 'claude-3-5-haiku-20241022' }
 */

/**
 * POST: Unified AI endpoint for all service types
 * Accepts full AI request in body with type discrimination
 */
export const POST = async (props: any, res: any) => {
    try {
        const request = props as AIRequest;

        // Validate request has required type
        if (!request.type) {
            res.status(400);
            return {
                success: false,
                error: 'Missing required field: type',
                supportedTypes: ['llm', 'embedding', 'speech-to-text', 'text-to-speech', 'image-generation']
            };
        }

        // Set default provider if not specified
        if (!request.config?.provider) {
            request.config = { ...request.config, provider: 'openai' };
        }

        console.log(`🤖 AI Request: ${request.type} via ${request.config.provider}`);
        const startTime = Date.now();

        // Execute AI request using unified interface with proper type narrowing
        const response: LLMResponse | EmbeddingResponse | SpeechToTextResponse | TextToSpeechResponse | ImageGenerationResponse = await (async () => {
            switch (request.type) {
                case 'llm': {
                    const llmResponse: LLMResponse = await ai(request);
                    return llmResponse
                };
                case 'embedding': {
                    const embeddingResponse: EmbeddingResponse = await ai(request);
                    return embeddingResponse;
                }
                case 'speech-to-text': {
                    const speechToTextResponse: SpeechToTextResponse = await ai(request);
                    return speechToTextResponse;
                }
                case 'text-to-speech': {
                    const textToSpeechResponse: TextToSpeechResponse = await ai(request);
                    return textToSpeechResponse;
                }
                case 'image-generation': {
                    const imageGenerationResponse: ImageGenerationResponse = await ai(request);
                    return imageGenerationResponse;
                }
                default:
                    // @ts-expect-error - This ensures exhaustive checking
                    throw new Error(`Unsupported AI service type: ${request.type}`);
            }
        })();

        const duration = Date.now() - startTime;
        console.log(`✅ AI Response: ${request.type} completed in ${duration}ms`);

        // Return successful response
        return {
            ...response,
            success: true,
            provider: request.config.provider,
            duration
        };

    } catch (error) {
        console.error('❌ AI Endpoint Error:', error);
        res.status(500);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        };
    }
};

/**
 * GET: Quick access endpoints with query parameters
 * Supports common AI operations via URL parameters
 */
export const GET = async (props: any, res: any) => {
    try {
        const { type, message, text, prompt, provider = 'openai', model, ...otherParams } = props;

        // Health check endpoint
        if (!type) {
            return {
                status: 'healthy',
                message: 'Copilotz AI Service is running',
                version: '2.0.0',
                endpoints: {
                    'POST /features/ai': 'Unified AI interface (full request in body)',
                    'GET /features/ai?type=chat&message=Hello': 'Quick chat',
                    'GET /features/ai?type=embed&text=Hello': 'Quick embedding',
                    'GET /features/ai?type=image&prompt=A cat': 'Quick image generation',
                    'GET /features/ai?type=speak&text=Hello&voice=alloy': 'Quick text-to-speech'
                },
                supportedProviders: ['openai', 'gemini', 'anthropic', 'groq', 'deepseek', 'cohere', 'elevenlabs', 'assemblyai', 'deepgram', 'azure', 'stability', 'replicate'],
                serviceTypes: ['llm', 'embedding', 'speech-to-text', 'text-to-speech', 'image-generation']
            };
        }

        console.log(`🤖 Quick AI Request: ${type} via ${provider}`);
        const startTime = Date.now();
        let response;

        // Route to appropriate service based on type
        switch (type.toLowerCase()) {
            case 'chat':
            case 'llm': {
                if (!message) {
                    res.status(400);
                    return { success: false, error: 'Missing required parameter: message' };
                }

                response = await chat({
                    messages: [{ role: 'user', content: message }],
                    config: {
                        provider: provider as any,
                        model: getDefaultModel(provider),
                        temperature: 0.7,
                        maxTokens: 500,
                        ...otherParams
                    }
                });
                break;
            }

            case 'embed':
            case 'embedding': {
                if (!text) {
                    res.status(400);
                    return { success: false, error: 'Missing required parameter: text' };
                }

                response = await embed({
                    input: text,
                    config: {
                        provider: provider as any,
                        model: getDefaultEmbeddingModel(provider),
                        ...otherParams
                    }
                });
                break;
            }

            case 'image':
            case 'generate': {
                if (!prompt) {
                    res.status(400);
                    return { success: false, error: 'Missing required parameter: prompt' };
                }

                response = await generateImage({
                    prompt,
                    config: {
                        provider: provider as any,
                        model: getDefaultImageModel(provider),
                        size: '1024x1024',
                        quality: 'standard',
                        n: 1,
                        ...otherParams
                    }
                });
                break;
            }

            case 'speak':
            case 'tts': {
                if (!text) {
                    res.status(400);
                    return { success: false, error: 'Missing required parameter: text' };
                }

                response = await speak({
                    text,
                    config: {
                        provider: provider as any,
                        model: getDefaultTTSModel(provider),
                        voice: otherParams.voice || 'alloy',
                        responseFormat: 'mp3',
                        speed: otherParams.speed || 1.0,
                        ...otherParams
                    }
                });
                break;
            }

            default: {
                res.status(400);
                return {
                    success: false,
                    error: `Unsupported quick access type: ${type}`,
                    supportedTypes: ['chat', 'llm', 'embed', 'embedding', 'image', 'generate', 'speak', 'tts']
                };
            }
        }

        const duration = Date.now() - startTime;
        console.log(`✅ Quick AI Response: ${type} completed in ${duration}ms`);

        return {
            success: true,
            type,
            provider,
            duration,
            ...response
        };

    } catch (error) {
        console.error('❌ Quick AI Endpoint Error:', error);
        res.status(500);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        };
    }
};

/**
 * Default function for other HTTP methods (OPTIONS, HEAD, etc.)
 */
export default (props: any, res: any) => {
    res.status(405);
    return {
        success: false,
        error: 'Method not allowed',
        allowedMethods: ['GET', 'POST', 'PUT', 'DELETE'],
        message: 'Use POST for full AI requests, GET for quick access, PUT for testing, DELETE for cleanup'
    };
};

// Helper functions for default model selection
function getDefaultModel(provider: string): string {
    const modelMap: Record<string, string> = {
        openai: 'gpt-4o-mini',
        anthropic: 'claude-3-5-haiku-20241022',
        gemini: 'gemini-1.5-flash',
        groq: 'llama-3.1-8b-instant',
        deepseek: 'deepseek-chat'
    };
    return modelMap[provider] || 'gpt-4o-mini';
}

function getDefaultEmbeddingModel(provider: string): string {
    const modelMap: Record<string, string> = {
        openai: 'text-embedding-3-small',
        cohere: 'embed-english-v3.0',
        huggingface: 'sentence-transformers/all-MiniLM-L6-v2'
    };
    return modelMap[provider] || 'text-embedding-3-small';
}

function getDefaultImageModel(provider: string): string {
    const modelMap: Record<string, string> = {
        openai: 'dall-e-3',
        stability: 'stable-diffusion-xl-1024-v1-0',
        replicate: 'stability-ai/sdxl'
    };
    return modelMap[provider] || 'dall-e-3';
}

function getDefaultTTSModel(provider: string): string {
    const modelMap: Record<string, string> = {
        openai: 'tts-1',
        elevenlabs: 'eleven_monolingual_v1',
        azure: 'tts'
    };
    return modelMap[provider] || 'tts-1';
}
