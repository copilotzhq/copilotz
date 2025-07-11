import type { 
  TextToSpeechProviderFactory, 
  TextToSpeechRequest, 
  TextToSpeechResponse, 
  TextToSpeechConfig 
} from '../../types.ts';

export const elevenlabsTextToSpeechProvider: TextToSpeechProviderFactory = (config: TextToSpeechConfig) => {
  return {
    name: 'elevenlabs',
    
    async speak(request: TextToSpeechRequest): Promise<TextToSpeechResponse> {
      const startTime = Date.now();
      
      try {
        // Get API key from config or environment
        const apiKey = config.apiKey || 
          Deno.env.get('DEFAULT_ELEVENLABS_KEY') || 
          Deno.env.get('ELEVENLABS_API_KEY');
        
        if (!apiKey) {
          throw new Error('ElevenLabs API key is required for text-to-speech');
        }
        
        // Popular voice IDs (can be overridden by config.voice)
        const voiceMap: Record<string, string> = {
          'alloy': '21m00Tcm4TlvDq8ikWAM',    // Rachel (default)
          'echo': 'AZnzlk1XvdvUeBnXmlld',     // Domi
          'fable': 'EXAVITQu4vr4xnSDxMaL',    // Bella
          'onyx': 'ErXwobaYiN019PkySvjV',     // Antoni
          'nova': 'MF3mGyEYCl7XYWbV9V6O',    // Elli
          'shimmer': 'TxGEqnHWrfWFTfGW9XjX'  // Josh
        };
        
        const voiceId = voiceMap[config.voice || 'alloy'] || config.voice || '21m00Tcm4TlvDq8ikWAM';
        
        // Prepare request payload
        const payload = {
          text: request.text,
          model_id: config.model || 'eleven_monolingual_v1',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5,
            style: 0.0,
            use_speaker_boost: true
          }
        };
        
        // Adjust voice settings based on speed
        if (config.speed) {
          // ElevenLabs doesn't have direct speed control, but we can adjust stability
          const speedAdjustment = Math.max(0.1, Math.min(1.0, config.speed));
          payload.voice_settings.stability = speedAdjustment;
        }
        
        // Make API request
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': apiKey,
          },
          body: JSON.stringify(payload),
        });
        
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`ElevenLabs API Error: ${error}`);
        }
        
        const audioBuffer = await response.arrayBuffer();
        const processingTime = Date.now() - startTime;
        
        // Convert ArrayBuffer to Blob
        const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
        
        // Estimate duration (rough calculation: ~150 words per minute, ~5 chars per word)
        const estimatedDuration = (request.text.length / 5) / 150 * 60;
        
        return {
          success: true,
          provider: 'elevenlabs',
          model: config.model || 'eleven_monolingual_v1',
          processingTime,
          audio: audioBlob,
          format: 'mp3',
          duration: estimatedDuration
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