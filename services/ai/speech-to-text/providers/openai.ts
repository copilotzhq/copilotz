import type { 
  SpeechToTextProviderFactory, 
  SpeechToTextRequest, 
  SpeechToTextResponse, 
  SpeechToTextConfig 
} from '../../types.ts';

export const openaiSpeechToTextProvider: SpeechToTextProviderFactory = (config: SpeechToTextConfig) => {
  return {
    name: 'openai',
    
    async transcribe(request: SpeechToTextRequest): Promise<SpeechToTextResponse> {
      const startTime = Date.now();
      
      try {
        // Get API key from config or environment
        const apiKey = config.apiKey || 
          Deno.env.get('DEFAULT_OPENAI_KEY') || 
          Deno.env.get('OPENAI_API_KEY');
        
        if (!apiKey) {
          throw new Error('OpenAI API key is required for speech-to-text');
        }
        
        // Prepare FormData
        const formData = new FormData();
        
        // Handle different audio input types
        if (request.audio instanceof Blob) {
          formData.append('file', request.audio);
        } else if (request.audio instanceof File) {
          formData.append('file', request.audio);
        } else if (request.audio instanceof ArrayBuffer) {
          const blob = new Blob([request.audio], { type: 'audio/wav' });
          formData.append('file', blob);
        } else {
          throw new Error('Unsupported audio format. Use Blob, File, or ArrayBuffer.');
        }
        
        // Add required parameters
        formData.append('model', config.model || 'whisper-1');
        formData.append('language', config.language || 'en');
        formData.append('response_format', config.responseFormat || 'verbose_json');
        
        // Add optional parameters
        if (config.temperature !== undefined) {
          formData.append('temperature', config.temperature.toString());
        }
        
        if (config.prompt) {
          formData.append('prompt', config.prompt);
        }
        
        // Make API request
        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
          body: formData,
        });
        
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`OpenAI API Error: ${error}`);
        }
        
        const data = await response.json();
        const processingTime = Date.now() - startTime;
        
        return {
          success: true,
          provider: 'openai',
          model: config.model || 'whisper-1',
          processingTime,
          text: data.text,
          language: data.language,
          duration: data.duration,
          segments: data.segments?.map((segment: any) => ({
            start: segment.start,
            end: segment.end,
            text: segment.text,
            confidence: segment.confidence
          }))
        };
        
      } catch (error) {
        const processingTime = Date.now() - startTime;
        return {
          success: false,
          processingTime,
          error: error instanceof Error ? error.message : String(error),
          text: ''
        };
      }
    }
  };
}; 