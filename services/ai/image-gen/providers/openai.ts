import type { 
  ImageGenerationProviderFactory, 
  ImageGenerationRequest, 
  ImageGenerationResponse, 
  ImageGenerationConfig 
} from '../../types.ts';

export const openaiImageGenerationProvider: ImageGenerationProviderFactory = (config: ImageGenerationConfig) => {
  return {
    name: 'openai',
    
    async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
      const startTime = Date.now();
      
      try {
        // Get API key from config or environment
        const apiKey = config.apiKey || 
          Deno.env.get('DEFAULT_OPENAI_KEY') || 
          Deno.env.get('OPENAI_API_KEY');
        
        if (!apiKey) {
          throw new Error('OpenAI API key is required for image generation');
        }
        
        // Prepare request payload
        const payload = {
          model: config.model || 'dall-e-3',
          prompt: request.prompt,
          size: config.size || '1024x1024',
          quality: config.quality || 'standard',
          style: config.style || 'vivid',
          response_format: config.responseFormat || 'url',
          n: config.n || 1
        };
        
        // Make API request
        const response = await fetch('https://api.openai.com/v1/images/generations', {
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
        
        const data = await response.json();
        const processingTime = Date.now() - startTime;
        
        return {
          success: true,
          provider: 'openai',
          model: config.model || 'dall-e-3',
          processingTime,
          images: data.data.map((item: any) => ({
            url: item.url,
            b64_json: item.b64_json,
            revisedPrompt: item.revised_prompt
          }))
        };
        
      } catch (error) {
        const processingTime = Date.now() - startTime;
        return {
          success: false,
          processingTime,
          error: error instanceof Error ? error.message : String(error),
          images: []
        };
      }
    }
  };
}; 