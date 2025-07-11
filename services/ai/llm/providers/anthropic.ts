import type { ProviderFactory, ProviderConfig, ChatMessage, MediaAttachment } from '../types.ts';
import { formatMediaForProvider } from '../media.ts';

export const anthropicProvider: ProviderFactory = (config: ProviderConfig) => {
  const transformMessages = (messages: ChatMessage[]) => {
    // Anthropic requires system prompts to be separate from messages
    const systemPrompts: string[] = [];
    const userMessages: any[] = [];
    
    messages.forEach(msg => {
      if (msg.role === 'system') {
        systemPrompts.push(msg.content);
      } else {
        // Handle multimodal content for Claude 3+
        if (msg.attachments?.length) {
          const content: any[] = [
            { type: 'text', text: msg.content }
          ];
          
          // Process image attachments
          msg.attachments.forEach(attachment => {
            if (attachment.type === 'image') {
              const formattedMedia = formatMediaForProvider(attachment, 'anthropic');
              if (formattedMedia) {
                content.push(formattedMedia);
              }
            }
          });
          
          userMessages.push({
            role: msg.role,
            content
          });
        } else {
          userMessages.push({
            role: msg.role,
            content: msg.content
          });
        }
      }
    });
    
    return { 
      messages: userMessages,
      system: systemPrompts.join('\n') || undefined 
    };
  };

  return {
    endpoint: 'https://api.anthropic.com/v1/messages',
    
    headers: (config: ProviderConfig) => ({
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey || '',
      'anthropic-version': '2023-06-01',
    }),
    
    transformMessages,
    
    body: (messages: ChatMessage[], config: ProviderConfig) => {
      const transformed = transformMessages(messages);
      
      return {
        model: config.model || 'claude-3-haiku-20240307',
        messages: transformed.messages,
        stream: true,
        temperature: config.temperature || 0,
        max_tokens: config.maxTokens || 1000,
        top_p: config.topP,
        top_k: config.topK,
        stop_sequences: config.stopSequences || config.stop,
        system: transformed.system,
        metadata: config.metadata,
      };
    },
    
    extractContent: (data: any) => {
      return data?.delta?.text || null;
    },
    
    // Multimodal capabilities (Claude 3+ models)
    capabilities: {
      vision: true,
      audio: false, // Claude doesn't support audio directly
      video: false,
      documents: true, // Excellent for document analysis
      maxImageSize: 20 * 1024 * 1024, // 20MB
      supportedFormats: {
        image: ['png', 'jpeg', 'jpg', 'gif', 'webp'],
        document: ['txt', 'pdf', 'md', 'docx', 'csv']
      }
    },
    
    // Media processing functions
    processMedia: {
      // Images are handled directly in the message transformation
      preprocessImages: async (attachments: MediaAttachment[]) => {
        return attachments.filter(att => 
          att.type === 'image' && 
          att.data?.startsWith('data:image/')
        );
      },
      
      // Claude doesn't support direct audio processing
      processAudio: async (attachment: MediaAttachment, config: ProviderConfig) => {
        return {
          success: false,
          type: 'audio' as const,
          error: 'Claude does not support direct audio processing. Consider using OpenAI Whisper for transcription first, then send the text to Claude for analysis.'
        };
      },
      
      // Video not supported
      processVideo: async (attachment: MediaAttachment, config: ProviderConfig) => {
        return {
          success: false,
          type: 'video' as const,
          error: 'Claude does not support video processing. Consider extracting frames using server-side tools (FFmpeg) first, then send images to Claude for analysis.'
        };
      },
      
      // Excellent document processing capabilities (once text is extracted)
      processDocument: async (attachment: MediaAttachment, config: ProviderConfig) => {
        const startTime = Date.now();
        
        try {
          // Claude excels at document analysis once text is extracted
          return {
            success: true,
            type: 'document' as const,
            result: {
              analysis: 'Claude excels at analyzing document content, extracting insights, and answering questions',
              summary: 'Claude can provide detailed analysis of document structure, content, and meaning once text is extracted',
              extractedText: 'Text extraction requires server-side OCR (PDF.js, Google Vision API, etc.)',
              metadata: {
                format: attachment.mimeType,
                size: attachment.size,
                recommendation: 'Use Claude for in-depth document analysis and reasoning after OCR',
                note: 'Implement server-side text extraction, then leverage Claude\'s superior document analysis capabilities'
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