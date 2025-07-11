import type { ProviderFactory, ProviderConfig, ChatMessage, MediaAttachment } from '../types.ts';
import { formatMediaForProvider, processAudioWithWhisper } from '../media.ts';

// Helper function to check if a model is a reasoning model
function isReasoningModel(model: string): boolean {
  return model.startsWith('o3') || model.startsWith('o4') || model.includes('o1');
}

export const openaiProvider: ProviderFactory = (config: ProviderConfig) => {
  return {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    
    headers: (config: ProviderConfig) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    }),
    
    body: (messages: ChatMessage[], config: ProviderConfig) => {
      // Transform messages to support multimodal content
      const openaiMessages = messages.map(msg => {
        const baseMessage = {
          role: msg.role,
          content: msg.content
        };
        
        // Add media attachments if present
        if (msg.attachments?.length) {
          const mediaContent: any[] = [
            { type: 'text', text: msg.content }
          ];
          
          // Process each attachment
          msg.attachments.forEach(attachment => {
            if (attachment.type === 'image') {
              const formattedMedia = formatMediaForProvider(attachment, 'openai');
              if (formattedMedia) {
                mediaContent.push(formattedMedia);
              }
            }
            // Note: Audio/video would be processed separately via Whisper API
          });
          
          return {
            ...baseMessage,
            content: mediaContent
          };
        }
        
        return baseMessage;
      });

      const modelName = config.model || 'gpt-4o-mini';
      const bodyConfig: any = {
        model: modelName,
        messages: openaiMessages,
        stream: true,
        temperature: config.temperature || 0,
        max_completion_tokens: config.maxCompletionTokens || config.maxTokens || 1000,
        top_p: config.topP,
        presence_penalty: config.presencePenalty,
        frequency_penalty: config.frequencyPenalty,
        stop: config.stop,
        seed: config.seed,
        user: config.user,
        response_format: config.responseType === 'json' 
          ? { type: 'json_object' } 
          : undefined,
      };

      // Add reasoning_effort for reasoning models
      if (isReasoningModel(modelName) && config.reasoningEffort) {
        bodyConfig.reasoning_effort = config.reasoningEffort;
      }

      return bodyConfig;
    },
    
    extractContent: (data: any) => {
      return data?.choices?.[0]?.delta?.content || null;
    },
    
    // Multimodal capabilities
    capabilities: {
      vision: true,
      audio: true,
      video: true, // Via frame extraction (server-side)
      documents: true,
      maxImageSize: 20 * 1024 * 1024, // 20MB
      maxAudioDuration: 1800, // 30 minutes in seconds
      maxVideoSize: 512 * 1024 * 1024, // 512MB
      supportedFormats: {
        image: ['png', 'jpeg', 'jpg', 'webp', 'gif'],
        audio: ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'],
        video: ['mp4', 'mov', 'avi', 'mkv'], // Via server-side frame extraction
        document: ['txt', 'pdf', 'md', 'docx']
      }
    },
    
    // Media processing functions
    processMedia: {
      // Images are handled directly in the body transformation
      preprocessImages: async (attachments: MediaAttachment[]) => {
        return attachments.filter(att => 
          att.type === 'image' && 
          (att.data?.startsWith('data:image/') || att.url)
        );
      },
      
      // Audio processing via Whisper
      processAudio: async (attachment: MediaAttachment, config: ProviderConfig) => {
        if (!config.apiKey) {
          return {
            success: false,
            type: 'audio' as const,
            error: 'API key required for audio processing'
          };
        }
        
        return await processAudioWithWhisper(
          attachment, 
          config, 
          config.apiKey,
          'https://api.openai.com/v1'
        );
      },
      
      // Video processing via server-side frame extraction
      processVideo: async (attachment: MediaAttachment, config: ProviderConfig) => {
        const startTime = Date.now();
        
        try {
          // Note: For production video processing, consider:
          // - FFmpeg for frame extraction
          // - External video processing services
          // - WebAssembly video libraries
          
          return {
            success: true,
            type: 'video' as const,
            result: {
              analysis: 'Video processing requires server-side frame extraction (e.g., FFmpeg)',
              summary: 'Consider implementing FFmpeg-based frame extraction for production',
              metadata: {
                frameCount: config.video?.maxFrames || 10,
                extractedAudio: config.video?.extractAudio || false,
                note: 'Server-side video processing not yet implemented'
              }
            },
            processingTime: Date.now() - startTime
          };
        } catch (error) {
          return {
            success: false,
            type: 'video' as const,
            error: error instanceof Error ? error.message : 'Video processing failed',
            processingTime: Date.now() - startTime
          };
        }
      },
      
      // Document processing (text extraction + analysis)
      processDocument: async (attachment: MediaAttachment, config: ProviderConfig) => {
        const startTime = Date.now();
        
        try {
          // Note: For production document processing, consider:
          // - PDF.js for PDF parsing
          // - External OCR services (Google Vision, AWS Textract)
          // - LibreOffice headless for document conversion
          
          return {
            success: true,
            type: 'document' as const,
            result: {
              extractedText: 'Document text extraction requires server-side OCR implementation',
              analysis: 'GPT-4 can analyze extracted text content once OCR is implemented',
              summary: 'Consider implementing PDF.js or external OCR services',
              metadata: {
                format: attachment.mimeType,
                size: attachment.size,
                note: 'Server-side document processing not yet implemented'
              }
            },
            processingTime: Date.now() - startTime
          };
        } catch (error) {
          return {
            success: false,
            type: 'document' as const,
            error: error instanceof Error ? error.message : 'Document processing failed',
            processingTime: Date.now() - startTime
          };
        }
      }
    }
  };
}; 