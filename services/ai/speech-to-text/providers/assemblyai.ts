import type { 
  SpeechToTextProviderFactory, 
  SpeechToTextRequest, 
  SpeechToTextResponse, 
  SpeechToTextConfig 
} from '../../types.ts';

export const assemblyaiSpeechToTextProvider: SpeechToTextProviderFactory = (config: SpeechToTextConfig) => {
  return {
    name: 'assemblyai',
    
    async transcribe(request: SpeechToTextRequest): Promise<SpeechToTextResponse> {
      const startTime = Date.now();
      
      try {
        // Get API key from config or environment
        const apiKey = config.apiKey || 
          Deno.env.get('DEFAULT_ASSEMBLYAI_KEY') || 
          Deno.env.get('ASSEMBLYAI_API_KEY');
        
        if (!apiKey) {
          throw new Error('AssemblyAI API key is required for speech-to-text');
        }
        
        // Step 1: Upload audio file
        const uploadResponse = await fetch('https://api.assemblyai.com/v2/upload', {
          method: 'POST',
          headers: {
            'Authorization': apiKey,
            'Content-Type': 'application/octet-stream',
          },
          body: request.audio,
        });
        
        if (!uploadResponse.ok) {
          const error = await uploadResponse.text();
          throw new Error(`AssemblyAI Upload Error: ${error}`);
        }
        
        const uploadData = await uploadResponse.json();
        const audioUrl = uploadData.upload_url;
        
        // Step 2: Create transcription job
        const transcriptPayload = {
          audio_url: audioUrl,
          language_code: config.language || 'en_us',
          punctuate: true,
          format_text: true,
          dual_channel: false,
          speaker_labels: true, // Enable speaker diarization
          auto_chapters: true,
          sentiment_analysis: false,
          auto_highlights: false,
          content_safety: false,
          iab_categories: false,
          ...(config.prompt && { boost_param: 'high', word_boost: [config.prompt] })
        };
        
        const transcriptResponse = await fetch('https://api.assemblyai.com/v2/transcript', {
          method: 'POST',
          headers: {
            'Authorization': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(transcriptPayload),
        });
        
        if (!transcriptResponse.ok) {
          const error = await transcriptResponse.text();
          throw new Error(`AssemblyAI Transcript Error: ${error}`);
        }
        
        const transcriptData = await transcriptResponse.json();
        const transcriptId = transcriptData.id;
        
        // Step 3: Poll for completion
        let transcript;
        let attempts = 0;
        const maxAttempts = 60; // 5 minutes timeout
        
        while (attempts < maxAttempts) {
          const statusResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
            headers: {
              'Authorization': apiKey,
            },
          });
          
          transcript = await statusResponse.json();
          
          if (transcript.status === 'completed') {
            break;
          } else if (transcript.status === 'error') {
            throw new Error(`AssemblyAI Transcription Error: ${transcript.error}`);
          }
          
          // Wait 5 seconds before next poll
          await new Promise(resolve => setTimeout(resolve, 5000));
          attempts++;
        }
        
        if (transcript?.status !== 'completed') {
          throw new Error('AssemblyAI transcription timeout');
        }
        
        const processingTime = Date.now() - startTime;
        
        // Extract segments with speaker information
        const segments = transcript.words?.map((word: any) => ({
          start: word.start / 1000, // Convert from ms to seconds
          end: word.end / 1000,
          text: word.text,
          confidence: word.confidence,
          speaker: word.speaker || 'A'
        })) || [];
        
        return {
          success: true,
          provider: 'assemblyai',
          model: config.model || 'best',
          processingTime,
          text: transcript.text || '',
          language: config.language || 'en',
          duration: transcript.audio_duration || 0,
          confidence: transcript.confidence || 0,
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