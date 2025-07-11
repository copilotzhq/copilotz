import type { 
  SpeechToTextProviderFactory, 
  SpeechToTextRequest, 
  SpeechToTextResponse, 
  SpeechToTextConfig 
} from '../../types.ts';

export const deepgramSpeechToTextProvider: SpeechToTextProviderFactory = (config: SpeechToTextConfig) => {
  return {
    name: 'deepgram',
    
    async transcribe(request: SpeechToTextRequest): Promise<SpeechToTextResponse> {
      const startTime = Date.now();
      
      try {
        // Get API key from config or environment
        const apiKey = config.apiKey || 
          Deno.env.get('DEFAULT_DEEPGRAM_KEY') || 
          Deno.env.get('DEEPGRAM_API_KEY');
        
        if (!apiKey) {
          throw new Error('Deepgram API key is required for speech-to-text');
        }
        
        // Build query parameters
        const params = new URLSearchParams({
          model: config.model || 'nova-2',
          language: config.language || 'en-US',
          punctuate: 'true',
          diarize: 'true', // Speaker diarization
          smart_format: 'true',
          utterances: 'true', // Get utterance-level timestamps
          paragraphs: 'true',
          sentiment: 'false',
          summarize: 'false',
          detect_topics: 'false'
        });
        
        // Add custom keywords if provided via prompt
        if (config.prompt) {
          params.append('keywords', config.prompt);
        }
        
        // Add response format specific parameters
        if (config.responseFormat === 'verbose_json') {
          params.append('alternatives', '1');
          params.append('confidence', 'true');
        }
        
        // Make API request
        const response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
          method: 'POST',
          headers: {
            'Authorization': `Token ${apiKey}`,
            'Content-Type': 'audio/*', // Deepgram auto-detects format
          },
          body: request.audio,
        });
        
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Deepgram API Error: ${error}`);
        }
        
        const data = await response.json();
        const processingTime = Date.now() - startTime;
        
        // Extract the best transcript
        const transcript = data.results?.channels?.[0]?.alternatives?.[0];
        const utterances = data.results?.utterances || [];
        
        if (!transcript) {
          throw new Error('No transcript found in Deepgram response');
        }
        
        // Build segments from utterances (more accurate than words)
        const segments = utterances.map((utterance: any) => ({
          start: utterance.start,
          end: utterance.end,
          text: utterance.transcript,
          confidence: utterance.confidence,
          speaker: `Speaker ${utterance.speaker}`
        }));
        
        // Calculate overall confidence
        const overallConfidence = utterances.length > 0 
          ? utterances.reduce((sum: number, u: any) => sum + (u.confidence || 0), 0) / utterances.length
          : transcript.confidence || 0;
        
        return {
          success: true,
          provider: 'deepgram',
          model: config.model || 'nova-2',
          processingTime,
          text: transcript.transcript || '',
          language: config.language || 'en',
          duration: data.metadata?.duration || 0,
          confidence: overallConfidence,
          segments: segments
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