import type { 
  ImageGenerationProviderFactory, 
  ImageGenerationRequest, 
  ImageGenerationResponse, 
  ImageGenerationConfig 
} from '../../types.ts';

export const stabilityImageGenerationProvider: ImageGenerationProviderFactory = (config: ImageGenerationConfig) => {
  return {
    name: 'stability',
    
    async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
      const startTime = Date.now();
      
      try {
        // Get API key from config or environment
        const apiKey = config.apiKey || 
          Deno.env.get('DEFAULT_STABILITY_KEY') || 
          Deno.env.get('STABILITY_API_KEY');
        
        if (!apiKey) {
          throw new Error('Stability AI API key is required for image generation');
        }
        
        // Map size to Stability format
        const sizeMap: Record<string, { width: number; height: number }> = {
          '256x256': { width: 256, height: 256 },
          '512x512': { width: 512, height: 512 },
          '1024x1024': { width: 1024, height: 1024 },
          '1792x1024': { width: 1792, height: 1024 },
          '1024x1792': { width: 1024, height: 1792 }
        };
        
        const dimensions = sizeMap[config.size || '1024x1024'];
        const engine = config.model || 'stable-diffusion-xl-1024-v1-0';
        
        // Prepare request payload
        const payload = {
          text_prompts: [
            {
              text: request.prompt,
              weight: 1
            }
          ],
          width: dimensions.width,
          height: dimensions.height,
          samples: config.n || 1,
          steps: 50, // Default steps for quality
          cfg_scale: 7, // Classifier Free Guidance scale
          style_preset: config.style === 'vivid' ? 'enhance' : 'photographic',
          ...(request.negativePrompt && {
            text_prompts: [
              { text: request.prompt, weight: 1 },
              { text: request.negativePrompt, weight: -1 }
            ]
          })
        };
        
        // Make API request
        const response = await fetch(`https://api.stability.ai/v1/generation/${engine}/text-to-image`, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Stability AI API Error: ${error}`);
        }
        
        const data = await response.json();
        const processingTime = Date.now() - startTime;
        
        // Transform response to our format
        const images = data.artifacts.map((artifact: any) => ({
          b64_json: artifact.base64,
          revisedPrompt: request.prompt // Stability doesn't revise prompts
        }));
        
        return {
          success: true,
          provider: 'stability',
          model: engine,
          processingTime,
          images: images,
          usage: {
            promptTokens: request.prompt.split(' ').length
          }
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