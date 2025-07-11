import type { 
  ImageGenerationProviderFactory, 
  ImageGenerationRequest, 
  ImageGenerationResponse, 
  ImageGenerationConfig 
} from '../../types.ts';

export const replicateImageGenerationProvider: ImageGenerationProviderFactory = (config: ImageGenerationConfig) => {
  return {
    name: 'replicate',
    
    async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
      const startTime = Date.now();
      
      try {
        // Get API key from config or environment
        const apiKey = config.apiKey || 
          Deno.env.get('DEFAULT_REPLICATE_KEY') || 
          Deno.env.get('REPLICATE_API_TOKEN');
        
        if (!apiKey) {
          throw new Error('Replicate API token is required for image generation');
        }
        
        // Map model names to Replicate model versions
        const modelMap: Record<string, string> = {
          'sdxl': 'stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b',
          'stable-diffusion-2.1': 'stability-ai/stable-diffusion:db21e45d3f7023abc2a46ee38a23973f6dce16bb082a930b0c49861f96d1e5bf',
          'kandinsky-2.2': 'ai-forever/kandinsky-2.2:ea1addaab376f4dc227f5368bbd8eff901820fd1cc14ed8cad63b29249e9d463',
          'midjourney': 'prompthero/openjourney:9936c2001faa2194a261c01381f90e65261879985476014a0a37a334593a05eb'
        };
        
        const model = modelMap[config.model || 'sdxl'] || modelMap['sdxl'];
        
        // Parse size
        const [width, height] = (config.size || '1024x1024').split('x').map(Number);
        
        // Prepare request payload
        const payload = {
          version: model.split(':')[1], // Extract version hash
          input: {
            prompt: request.prompt,
            width: width,
            height: height,
            num_outputs: config.n || 1,
            guidance_scale: 7.5,
            num_inference_steps: 50,
            ...(request.negativePrompt && { negative_prompt: request.negativePrompt }),
            ...(config.style === 'vivid' && { guidance_scale: 12 }),
            ...(config.quality === 'hd' && { num_inference_steps: 80 })
          }
        };
        
        // Create prediction
        const predictionResponse = await fetch('https://api.replicate.com/v1/predictions', {
          method: 'POST',
          headers: {
            'Authorization': `Token ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        
        if (!predictionResponse.ok) {
          const error = await predictionResponse.text();
          throw new Error(`Replicate API Error: ${error}`);
        }
        
        const prediction = await predictionResponse.json();
        const predictionId = prediction.id;
        
        // Poll for completion
        let result;
        let attempts = 0;
        const maxAttempts = 60; // 5 minutes timeout
        
        while (attempts < maxAttempts) {
          const statusResponse = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
            headers: {
              'Authorization': `Token ${apiKey}`,
            },
          });
          
          result = await statusResponse.json();
          
          if (result.status === 'succeeded') {
            break;
          } else if (result.status === 'failed') {
            throw new Error(`Replicate prediction failed: ${result.error}`);
          }
          
          // Wait 5 seconds before next poll
          await new Promise(resolve => setTimeout(resolve, 5000));
          attempts++;
        }
        
        if (result?.status !== 'succeeded') {
          throw new Error('Replicate prediction timeout');
        }
        
        const processingTime = Date.now() - startTime;
        
        // Convert URLs to base64 if needed
        const images = [];
        const outputs = Array.isArray(result.output) ? result.output : [result.output];
        
        for (const url of outputs) {
          if (config.responseFormat === 'b64_json') {
            // Download and convert to base64
            const imageResponse = await fetch(url);
            const imageBuffer = await imageResponse.arrayBuffer();
            const base64 = btoa(String.fromCharCode(...new Uint8Array(imageBuffer)));
            images.push({ b64_json: base64, revisedPrompt: request.prompt });
          } else {
            images.push({ url: url, revisedPrompt: request.prompt });
          }
        }
        
        return {
          success: true,
          provider: 'replicate',
          model: config.model || 'sdxl',
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