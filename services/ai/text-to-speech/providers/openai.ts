import type { 
  TextToSpeechProviderFactory, 
  TextToSpeechRequest, 
  TextToSpeechResponse, 
  TextToSpeechConfig 
} from '../../types.ts';

export const openaiTextToSpeechProvider: TextToSpeechProviderFactory = (config: TextToSpeechConfig) => {
  return {
    name: 'openai',
    
    async speak(request: TextToSpeechRequest): Promise<TextToSpeechResponse> {
      const startTime = Date.now();
      
      try {
        // Get API key from config or environment
        const apiKey = config.apiKey || 
          Deno.env.get('DEFAULT_OPENAI_KEY') || 
          Deno.env.get('OPENAI_API_KEY');
        
        if (!apiKey) {
          throw new Error('OpenAI API key is required for text-to-speech');
        }
        
        // Prepare request payload
        const payload = {
          model: config.model || 'tts-1',
          input: request.text,
          voice: config.voice || 'alloy',
          response_format: config.responseFormat || 'mp3',
          speed: config.speed || 1.0
        };
        
        // Make API request
        const response = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`OpenAI API Error: ${error}`);
        }
        
        const audioBuffer = await response.arrayBuffer();
        const processingTime = Date.now() - startTime;
        
        return {
          success: true,
          provider: 'openai',
          model: config.model || 'tts-1',
          processingTime,
          audio: audioBuffer,
          format: config.responseFormat || 'mp3'
        };
        
      } catch (error) {
        const processingTime = Date.now() - startTime;
        return {
          success: false,
          processingTime,
          error: error instanceof Error ? error.message : String(error),
          audio: new ArrayBuffer(0),
          format: 'mp3'
        };
      }
    }
  };
}; 