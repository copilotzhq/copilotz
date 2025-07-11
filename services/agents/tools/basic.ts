/**
 * Agentic Tool Framework - Basic Tools
 * Core tool implementations for knowledge base and AI services
 */

import type { ToolDefinition } from '../types.ts';
import { SchemaBuilders, CommonSchemas } from '../validation.ts';
import { createKnowledgeBase } from '../../knowledge/index.ts';
import { ai } from '../../ai/index.ts';

// =============================================================================
// KNOWLEDGE BASE TOOLS
// =============================================================================

/**
 * Knowledge Base Query Tool
 * Queries the knowledge base for relevant information
 */
export const knowledgeQueryTool: ToolDefinition = {
  id: 'knowledge-query',
  name: 'Knowledge Query',
  description: 'Search and retrieve information from the knowledge base',
  version: '1.0.0',
  category: 'data',
  type: 'knowledge',
  
  input: {
    schema: SchemaBuilders.object({
      query: SchemaBuilders.string({
        description: 'Search query to find relevant information',
        minLength: 1,
        maxLength: 500
      }),
      limit: SchemaBuilders.number({
        description: 'Maximum number of results to return',
        minimum: 1,
        maximum: 50,
        default: 10
      }),
      collection: SchemaBuilders.string({
        description: 'Optional collection to search within',
        minLength: 1,
        maxLength: 100
      })
    }, ['query']),
    required: ['query']
  },
  
  output: {
    schema: SchemaBuilders.object({
      results: SchemaBuilders.array(SchemaBuilders.object({
        id: { type: 'string' },
        content: { type: 'string' },
        metadata: { type: 'object' },
        score: { type: 'number' }
      })),
      total: { type: 'number' },
      query: { type: 'string' },
      collection: { type: 'string' }
    }, ['results', 'total', 'query'])
  },
  
  implementation: {
    type: 'function',
    handler: async (input: any) => {
      const kb = await createKnowledgeBase({
        database: { url: ':memory:' }
      });
      
      try {
        const response = await kb.process({
          type: 'search',
          query: input.query,
          config: {
            searchType: 'hybrid',
            limit: input.limit || 10
          },
          collectionId: input.collection
        });
        
        if (response.type === 'search') {
          return {
            results: response.results || [],
            total: response.totalResults || 0,
            query: input.query,
            collection: input.collection || 'default'
          };
        } else {
          throw new Error('Unexpected response type from knowledge base');
        }
      } finally {
        await kb.close();
      }
    }
  },
  
  permissions: {
    networkAccess: false,
    fileSystemAccess: false,
    requiresAuthentication: false
  },
  
  execution: {
    environment: 'main',
    timeout: 30000,
    resourceLimits: {
      maxMemoryMB: 128,
      maxExecutionTimeMs: 30000,
      maxConcurrentExecutions: 5
    }
  },
  
  metadata: {
    author: 'Copilotz',
    tags: ['knowledge', 'search', 'query', 'retrieval'],
    deprecated: false,
    experimental: false
  }
};

/**
 * Knowledge Base Ingest Tool
 * Adds new content to the knowledge base
 */
export const knowledgeIngestTool: ToolDefinition = {
  id: 'knowledge-ingest',
  name: 'Knowledge Ingest',
  description: 'Add new content to the knowledge base',
  version: '1.0.0',
  category: 'data',
  type: 'knowledge',
  
  input: {
    schema: SchemaBuilders.object({
      content: SchemaBuilders.string({
        description: 'Content to add to the knowledge base',
        minLength: 1,
        maxLength: 10000
      }),
      metadata: SchemaBuilders.object({
        title: { type: 'string' },
        source: { type: 'string' },
        tags: SchemaBuilders.array({ type: 'string' }),
        timestamp: { type: 'string' }
      }),
      collection: SchemaBuilders.string({
        description: 'Collection to add the content to',
        minLength: 1,
        maxLength: 100,
        default: 'default'
      })
    }, ['content']),
    required: ['content']
  },
  
  output: {
    schema: SchemaBuilders.object({
      success: { type: 'boolean' },
      id: { type: 'string' },
      collection: { type: 'string' },
      message: { type: 'string' }
    }, ['success', 'id'])
  },
  
  implementation: {
    type: 'function',
    handler: async (input: any) => {
      const kb = await createKnowledgeBase({
        database: { url: ':memory:' }
      });
      
      try {
        const response = await kb.process({
          type: 'ingest',
          source: {
            type: 'text',
            content: input.content,
            title: input.metadata?.title || 'Untitled Document'
          },
          collectionId: input.collection
        });
        
        if (response.type === 'ingest' && response.success) {
          return {
            success: true,
            id: response.documentId || 'unknown',
            collection: input.collection || 'default',
            message: 'Content successfully added to knowledge base'
          };
        } else {
          throw new Error(response.error || 'Failed to ingest document');
        }
      } finally {
        await kb.close();
      }
    }
  },
  
  permissions: {
    networkAccess: false,
    fileSystemAccess: false,
    requiresAuthentication: false
  },
  
  execution: {
    environment: 'main',
    timeout: 60000,
    resourceLimits: {
      maxMemoryMB: 256,
      maxExecutionTimeMs: 60000,
      maxConcurrentExecutions: 3
    }
  },
  
  metadata: {
    author: 'Copilotz',
    tags: ['knowledge', 'ingest', 'add', 'content'],
    deprecated: false,
    experimental: false
  }
};

// =============================================================================
// AI TOOLS
// =============================================================================

/**
 * LLM Chat Tool
 * Generates text responses using language models
 */
export const llmChatTool: ToolDefinition = {
  id: 'llm-chat',
  name: 'LLM Chat',
  description: 'Generate text responses using large language models',
  version: '1.0.0',
  category: 'core',
  type: 'ai',
  
  input: {
    schema: SchemaBuilders.object({
      prompt: SchemaBuilders.string({
        description: 'Input prompt for the language model',
        minLength: 1,
        maxLength: 10000
      }),
      model: SchemaBuilders.string({
        description: 'Model to use for generation',
        enum: ['gpt-4', 'gpt-3.5-turbo', 'claude-3-sonnet', 'gemini-pro'],
        default: 'gpt-3.5-turbo'
      }),
      maxTokens: SchemaBuilders.number({
        description: 'Maximum number of tokens to generate',
        minimum: 1,
        maximum: 4000,
        default: 1000
      }),
      temperature: SchemaBuilders.number({
        description: 'Sampling temperature (0.0 to 1.0)',
        minimum: 0.0,
        maximum: 1.0,
        default: 0.7
      }),
      systemPrompt: SchemaBuilders.string({
        description: 'System prompt to guide the model behavior',
        maxLength: 1000
      })
    }, ['prompt']),
    required: ['prompt']
  },
  
  output: {
    schema: SchemaBuilders.object({
      response: { type: 'string' },
      model: { type: 'string' },
      tokensUsed: { type: 'number' },
      finishReason: { type: 'string' }
    }, ['response', 'model'])
  },
  
  implementation: {
    type: 'function',
    handler: async (input: any) => {
      const messages = [
        ...(input.systemPrompt ? [{ role: 'system', content: input.systemPrompt }] : []),
        { role: 'user', content: input.prompt }
      ];
      
      console.log(`🔧 [TOOL-DEBUG] Calling AI service for LLM...`);
      const result = await ai({
        type: 'llm',
        messages,
        config: {
          model: input.model || 'gpt-4o-mini',
          maxTokens: input.maxTokens || 1000,
          temperature: input.temperature || 0.7
        }
      });
      
      console.log(`🔧 [TOOL-DEBUG] AI service response:`, {
        success: result.success,
        answer: result.answer?.substring(0, 50),
        error: result.error,
        tokens: result.tokens
      });
      
      if (!result.success) {
        throw new Error(result.error || 'LLM request failed');
      }
      
      return {
        response: result.answer || '',
        model: input.model || 'gpt-4o-mini',
        tokensUsed: result.tokens?.total || 0,
        finishReason: 'complete'
      };
    }
  },
  
  permissions: {
    networkAccess: true,
    fileSystemAccess: false,
    requiresAuthentication: true
  },
  
  execution: {
    environment: 'main',
    timeout: 120000,
    resourceLimits: {
      maxMemoryMB: 512,
      maxExecutionTimeMs: 120000,
      maxConcurrentExecutions: 10
    }
  },
  
  metadata: {
    author: 'Copilotz',
    tags: ['ai', 'llm', 'chat', 'text-generation'],
    deprecated: false,
    experimental: false
  }
};

/**
 * Text Embedding Tool
 * Generates embeddings for text content
 */
export const textEmbeddingTool: ToolDefinition = {
  id: 'text-embedding',
  name: 'Text Embedding',
  description: 'Generate vector embeddings for text content',
  version: '1.0.0',
  category: 'core',
  type: 'ai',
  
  input: {
    schema: SchemaBuilders.object({
      text: SchemaBuilders.string({
        description: 'Text to generate embeddings for',
        minLength: 1,
        maxLength: 5000
      }),
      model: SchemaBuilders.string({
        description: 'Embedding model to use',
        enum: ['text-embedding-ada-002', 'text-embedding-3-small', 'text-embedding-3-large'],
        default: 'text-embedding-ada-002'
      })
    }, ['text']),
    required: ['text']
  },
  
  output: {
    schema: SchemaBuilders.object({
      embedding: SchemaBuilders.array({ type: 'number' }),
      model: { type: 'string' },
      dimensions: { type: 'number' },
      tokensUsed: { type: 'number' }
    }, ['embedding', 'model', 'dimensions'])
  },
  
  implementation: {
    type: 'function',
    handler: async (input: any) => {
      console.log(`🔧 [EMBED-DEBUG] Calling AI service for embedding...`);
      const result = await ai({
        type: 'embedding',
        input: input.text,
        config: {
          model: input.model || 'text-embedding-3-small'
        }
      });
      
      console.log(`🔧 [EMBED-DEBUG] AI service response:`, {
        success: result.success,
        embeddings: Array.isArray(result.embeddings) ? `Array(${result.embeddings.length})` : result.embeddings,
        error: result.error,
        usage: result.usage
      });
      
      if (!result.success) {
        throw new Error(result.error || 'Embedding request failed');
      }
      
      // result.embeddings is already the embedding array, not an array of arrays
      const embedding = Array.isArray(result.embeddings) && result.embeddings.length > 0 
        ? result.embeddings  // Don't take [0], the whole array IS the embedding
        : [];
      
      console.log(`🔧 [EMBED-DEBUG] Processed embedding: length=${embedding.length}`);
      
      return {
        embedding,
        model: input.model || 'text-embedding-3-small',
        dimensions: embedding.length,
        tokensUsed: result.usage?.totalTokens || 0
      };
    }
  },
  
  permissions: {
    networkAccess: true,
    fileSystemAccess: false,
    requiresAuthentication: true
  },
  
  execution: {
    environment: 'main',
    timeout: 30000,
    resourceLimits: {
      maxMemoryMB: 256,
      maxExecutionTimeMs: 30000,
      maxConcurrentExecutions: 20
    }
  },
  
  metadata: {
    author: 'Copilotz',
    tags: ['ai', 'embedding', 'vector', 'text'],
    deprecated: false,
    experimental: false
  }
};

/**
 * Text to Speech Tool
 * Converts text to speech audio
 */
export const textToSpeechTool: ToolDefinition = {
  id: 'text-to-speech',
  name: 'Text to Speech',
  description: 'Convert text to speech audio',
  version: '1.0.0',
  category: 'core',
  type: 'ai',
  
  input: {
    schema: SchemaBuilders.object({
      text: SchemaBuilders.string({
        description: 'Text to convert to speech',
        minLength: 1,
        maxLength: 2000
      }),
      voice: SchemaBuilders.string({
        description: 'Voice to use for synthesis',
        enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
        default: 'alloy'
      }),
      model: SchemaBuilders.string({
        description: 'TTS model to use',
        enum: ['tts-1', 'tts-1-hd'],
        default: 'tts-1'
      }),
      speed: SchemaBuilders.number({
        description: 'Speech speed (0.25 to 4.0)',
        minimum: 0.25,
        maximum: 4.0,
        default: 1.0
      })
    }, ['text']),
    required: ['text']
  },
  
  output: {
    schema: SchemaBuilders.object({
      audioUrl: { type: 'string' },
      audioData: { type: 'string' }, // Base64 encoded
      voice: { type: 'string' },
      model: { type: 'string' },
      duration: { type: 'number' }
    }, ['audioUrl', 'voice', 'model'])
  },
  
  implementation: {
    type: 'function',
    handler: async (input: any) => {
      const result = await ai({
        type: 'text-to-speech',
        text: input.text,
        config: {
          voice: input.voice || 'alloy',
          model: input.model || 'tts-1',
          speed: input.speed || 1.0,
          responseFormat: 'mp3'
        }
      });
      
      if (!result.success) {
        throw new Error(result.error || 'Text-to-speech request failed');
      }
      
      // Convert ArrayBuffer to base64
      const audioData = result.audio ? btoa(String.fromCharCode(...new Uint8Array(result.audio))) : '';
      
      return {
        audioUrl: '', // Not provided by unified service
        audioData,
        voice: input.voice || 'alloy',
        model: input.model || 'tts-1',
        duration: 0 // Not provided by unified service
      };
    }
  },
  
  permissions: {
    networkAccess: true,
    fileSystemAccess: false,
    requiresAuthentication: true
  },
  
  execution: {
    environment: 'main',
    timeout: 60000,
    resourceLimits: {
      maxMemoryMB: 1024,
      maxExecutionTimeMs: 60000,
      maxConcurrentExecutions: 5
    }
  },
  
  metadata: {
    author: 'Copilotz',
    tags: ['ai', 'tts', 'speech', 'audio'],
    deprecated: false,
    experimental: false
  }
};

/**
 * Speech to Text Tool
 * Converts speech audio to text
 */
export const speechToTextTool: ToolDefinition = {
  id: 'speech-to-text',
  name: 'Speech to Text',
  description: 'Convert speech audio to text',
  version: '1.0.0',
  category: 'core',
  type: 'ai',
  
  input: {
    schema: SchemaBuilders.object({
      audioUrl: SchemaBuilders.string({
        description: 'URL of the audio file to transcribe',
        pattern: '^https?://.*'
      }),
      audioData: SchemaBuilders.string({
        description: 'Base64 encoded audio data'
      }),
      model: SchemaBuilders.string({
        description: 'STT model to use',
        enum: ['whisper-1'],
        default: 'whisper-1'
      }),
      language: SchemaBuilders.string({
        description: 'Language code (e.g., "en", "es", "fr")',
        pattern: '^[a-z]{2}$'
      })
    }),
    required: [] // Either audioUrl or audioData is required
  },
  
  output: {
    schema: SchemaBuilders.object({
      text: { type: 'string' },
      language: { type: 'string' },
      confidence: { type: 'number' },
      duration: { type: 'number' },
      model: { type: 'string' }
    }, ['text', 'model'])
  },
  
  implementation: {
    type: 'function',
    handler: async (input: any) => {
      if (!input.audioUrl && !input.audioData) {
        throw new Error('Either audioUrl or audioData must be provided');
      }
      
      // Convert audioData to Blob if provided
      let audio: Blob | undefined;
      if (input.audioData) {
        const binaryString = atob(input.audioData);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        audio = new Blob([bytes], { type: 'audio/mpeg' });
      }
      
      const result = await ai({
        type: 'speech-to-text',
        audio: audio!,
        audioUrl: input.audioUrl,
        config: {
          model: input.model || 'whisper-1',
          language: input.language || 'en',
          responseFormat: 'verbose_json'
        }
      });
      
      if (!result.success) {
        throw new Error(result.error || 'Speech-to-text request failed');
      }
      
      return {
        text: result.text || '',
        language: result.language || input.language || 'en',
        confidence: 0.95, // Not provided by unified service
        duration: result.duration || 0,
        model: input.model || 'whisper-1'
      };
    }
  },
  
  permissions: {
    networkAccess: true,
    fileSystemAccess: false,
    requiresAuthentication: true
  },
  
  execution: {
    environment: 'main',
    timeout: 120000,
    resourceLimits: {
      maxMemoryMB: 1024,
      maxExecutionTimeMs: 120000,
      maxConcurrentExecutions: 3
    }
  },
  
  metadata: {
    author: 'Copilotz',
    tags: ['ai', 'stt', 'transcription', 'audio'],
    deprecated: false,
    experimental: false
  }
};

/**
 * Image Generation Tool
 * Generates images from text descriptions
 */
export const imageGenerationTool: ToolDefinition = {
  id: 'image-generation',
  name: 'Image Generation',
  description: 'Generate images from text descriptions',
  version: '1.0.0',
  category: 'core',
  type: 'ai',
  
  input: {
    schema: SchemaBuilders.object({
      prompt: SchemaBuilders.string({
        description: 'Text description of the image to generate',
        minLength: 1,
        maxLength: 1000
      }),
      model: SchemaBuilders.string({
        description: 'Image generation model to use',
        enum: ['dall-e-3', 'dall-e-2', 'stable-diffusion-xl'],
        default: 'dall-e-3'
      }),
      size: SchemaBuilders.string({
        description: 'Image size',
        enum: ['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792'],
        default: '1024x1024'
      }),
      quality: SchemaBuilders.string({
        description: 'Image quality',
        enum: ['standard', 'hd'],
        default: 'standard'
      }),
      style: SchemaBuilders.string({
        description: 'Image style',
        enum: ['vivid', 'natural'],
        default: 'vivid'
      })
    }, ['prompt']),
    required: ['prompt']
  },
  
  output: {
    schema: SchemaBuilders.object({
      imageUrl: { type: 'string' },
      imageData: { type: 'string' }, // Base64 encoded
      prompt: { type: 'string' },
      model: { type: 'string' },
      size: { type: 'string' },
      revisedPrompt: { type: 'string' }
    }, ['imageUrl', 'prompt', 'model', 'size'])
  },
  
  implementation: {
    type: 'function',
    handler: async (input: any) => {
      const result = await ai({
        type: 'image-generation',
        prompt: input.prompt,
        config: {
          model: input.model || 'dall-e-3',
          size: input.size || '1024x1024',
          quality: input.quality || 'standard',
          style: input.style || 'vivid',
          responseFormat: 'url'
        }
      });
      
      if (!result.success) {
        throw new Error(result.error || 'Image generation request failed');
      }
      
      const firstImage = Array.isArray(result.images) && result.images.length > 0 
        ? result.images[0] 
        : null;
      
      return {
        imageUrl: firstImage?.url || '',
        imageData: firstImage?.b64_json || '',
        prompt: input.prompt,
        model: input.model || 'dall-e-3',
        size: input.size || '1024x1024',
        revisedPrompt: firstImage?.revised_prompt || input.prompt
      };
    }
  },
  
  permissions: {
    networkAccess: true,
    fileSystemAccess: false,
    requiresAuthentication: true
  },
  
  execution: {
    environment: 'main',
    timeout: 180000,
    resourceLimits: {
      maxMemoryMB: 2048,
      maxExecutionTimeMs: 180000,
      maxConcurrentExecutions: 2
    }
  },
  
  metadata: {
    author: 'Copilotz',
    tags: ['ai', 'image', 'generation', 'dalle', 'stable-diffusion'],
    deprecated: false,
    experimental: false
  }
};

// =============================================================================
// UTILITY TOOLS
// =============================================================================

/**
 * Text Processing Tool
 * Performs various text processing operations
 */
export const textProcessingTool: ToolDefinition = {
  id: 'text-processing',
  name: 'Text Processing',
  description: 'Perform various text processing operations',
  version: '1.0.0',
  category: 'utility',
  type: 'function',
  
  input: {
    schema: SchemaBuilders.object({
      text: SchemaBuilders.string({
        description: 'Text to process',
        minLength: 1,
        maxLength: 50000
      }),
      operation: SchemaBuilders.string({
        description: 'Text processing operation to perform',
        enum: ['uppercase', 'lowercase', 'titlecase', 'reverse', 'wordcount', 'charcount', 'extract-emails', 'extract-urls', 'remove-html', 'sanitize']
      }),
      options: SchemaBuilders.object({
        preserveSpaces: { type: 'boolean', default: true },
        trimWhitespace: { type: 'boolean', default: false }
      })
    }, ['text', 'operation']),
    required: ['text', 'operation']
  },
  
  output: {
    schema: SchemaBuilders.object({
      result: { type: 'string' },
      operation: { type: 'string' },
      metadata: SchemaBuilders.object({
        originalLength: { type: 'number' },
        processedLength: { type: 'number' },
        wordCount: { type: 'number' },
        charCount: { type: 'number' }
      })
    }, ['result', 'operation'])
  },
  
  implementation: {
    type: 'function',
    handler: async (input: any) => {
      const { text, operation, options = {} } = input;
      let result = text;
      
      switch (operation) {
        case 'uppercase':
          result = text.toUpperCase();
          break;
        case 'lowercase':
          result = text.toLowerCase();
          break;
        case 'titlecase':
          result = text.replace(/\w\S*/g, (txt) => 
            txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
          );
          break;
        case 'reverse':
          result = text.split('').reverse().join('');
          break;
        case 'wordcount':
          result = text.split(/\s+/).filter(word => word.length > 0).length.toString();
          break;
        case 'charcount':
          result = text.length.toString();
          break;
        case 'extract-emails':
          const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
          result = JSON.stringify(text.match(emailRegex) || []);
          break;
        case 'extract-urls':
          const urlRegex = /https?:\/\/[^\s]+/g;
          result = JSON.stringify(text.match(urlRegex) || []);
          break;
        case 'remove-html':
          result = text.replace(/<[^>]*>/g, '');
          break;
        case 'sanitize':
          result = text.replace(/[<>'"&]/g, '');
          break;
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
      
      if (options.trimWhitespace) {
        result = result.trim();
      }
      
      return {
        result,
        operation,
        metadata: {
          originalLength: text.length,
          processedLength: result.length,
          wordCount: text.split(/\s+/).filter(word => word.length > 0).length,
          charCount: text.length
        }
      };
    }
  },
  
  permissions: {
    networkAccess: false,
    fileSystemAccess: false,
    requiresAuthentication: false
  },
  
  execution: {
    environment: 'sandboxed',
    timeout: 10000,
    resourceLimits: {
      maxMemoryMB: 64,
      maxExecutionTimeMs: 10000,
      maxConcurrentExecutions: 50
    }
  },
  
  metadata: {
    author: 'Copilotz',
    tags: ['utility', 'text', 'processing', 'string'],
    deprecated: false,
    experimental: false
  }
};

// =============================================================================
// TOOL REGISTRY
// =============================================================================

/**
 * All basic tools available in the framework
 */
export const BASIC_TOOLS: ToolDefinition[] = [
  // Knowledge tools
  knowledgeQueryTool,
  knowledgeIngestTool,
  
  // AI tools
  llmChatTool,
  textEmbeddingTool,
  textToSpeechTool,
  speechToTextTool,
  imageGenerationTool,
  
  // Utility tools
  textProcessingTool
];

/**
 * Get a specific basic tool by ID
 */
export function getBasicTool(toolId: string): ToolDefinition | undefined {
  return BASIC_TOOLS.find(tool => tool.id === toolId);
}

/**
 * Get basic tools by category
 */
export function getBasicToolsByCategory(category: string): ToolDefinition[] {
  return BASIC_TOOLS.filter(tool => tool.category === category);
}

/**
 * Get basic tools by type
 */
export function getBasicToolsByType(type: string): ToolDefinition[] {
  return BASIC_TOOLS.filter(tool => tool.type === type);
} 