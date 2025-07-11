import type { 
  TextToSpeechProviderFactory, 
  TextToSpeechRequest, 
  TextToSpeechResponse, 
  TextToSpeechConfig 
} from '../../types.ts';

export const azureTextToSpeechProvider: TextToSpeechProviderFactory = (config: TextToSpeechConfig) => {
  return {
    name: 'azure',
    
    async speak(request: TextToSpeechRequest): Promise<TextToSpeechResponse> {
      const startTime = Date.now();
      
      try {
        // Get API key and region from config or environment
        const apiKey = config.apiKey || 
          Deno.env.get('DEFAULT_AZURE_SPEECH_KEY') || 
          Deno.env.get('AZURE_SPEECH_KEY');
        
        const region = Deno.env.get('AZURE_SPEECH_REGION') || 'eastus';
        
        if (!apiKey) {
          throw new Error('Azure Speech API key is required for text-to-speech');
        }
        
        // Map common voice names to Azure voice names
        const voiceMap: Record<string, string> = {
          'alloy': 'en-US-JennyNeural',
          'echo': 'en-US-GuyNeural', 
          'fable': 'en-US-AriaNeural',
          'onyx': 'en-US-DavisNeural',
          'nova': 'en-US-JaneNeural',
          'shimmer': 'en-US-JasonNeural'
        };
        
        const voice = voiceMap[config.voice || 'alloy'] || config.voice || 'en-US-JennyNeural';
        
        // Format output format
        const formatMap: Record<string, string> = {
          'mp3': 'audio-24khz-48kbitrate-mono-mp3',
          'wav': 'riff-24khz-16bit-mono-pcm',
          'opus': 'opus-24khz-16bit-mono',
          'aac': 'audio-24khz-96kbitrate-mono-aac',
          'flac': 'riff-24khz-16bit-mono-pcm' // Azure doesn't support FLAC directly
        };
        
        const outputFormat = formatMap[config.responseFormat || 'mp3'];
        
        // Build SSML with speed control
        const speedRate = config.speed ? `${Math.max(0.5, Math.min(2.0, config.speed))}` : '1.0';
        
        const ssml = `
          <speak version='1.0' xml:lang='en-US'>
            <voice xml:lang='en-US' xml:gender='Female' name='${voice}'>
              <prosody rate='${speedRate}'>
                ${request.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}
              </prosody>
            </voice>
          </speak>
        `.trim();
        
        // Make API request
        const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': apiKey,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': outputFormat,
            'User-Agent': 'AxionAI'
          },
          body: ssml,
        });
        
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Azure Speech API Error: ${error}`);
        }
        
        const audioBuffer = await response.arrayBuffer();
        const processingTime = Date.now() - startTime;
        
        // Convert ArrayBuffer to Blob with appropriate MIME type
        const mimeType = config.responseFormat === 'wav' ? 'audio/wav' : 
                        config.responseFormat === 'opus' ? 'audio/opus' :
                        config.responseFormat === 'aac' ? 'audio/aac' : 'audio/mpeg';
        
        const audioBlob = new Blob([audioBuffer], { type: mimeType });
        
        // Estimate duration (rough calculation: ~150 words per minute, ~5 chars per word)
        const estimatedDuration = (request.text.length / 5) / 150 * 60;
        
        return {
          success: true,
          provider: 'azure',
          model: voice,
          processingTime,
          audio: audioBlob,
          format: config.responseFormat || 'mp3',
          duration: estimatedDuration
        };
        
      } catch (error) {
        const processingTime = Date.now() - startTime;
        return {
          success: false,
          processingTime,
          error: error instanceof Error ? error.message : String(error),
          audio: new ArrayBuffer(0),
          format: config.responseFormat || 'mp3'
        };
      }
    }
  };
}; 