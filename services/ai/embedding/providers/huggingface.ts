import type { 
  EmbeddingProviderFactory, 
  EmbeddingRequest, 
  EmbeddingResponse, 
  EmbeddingConfig 
} from '../../types.ts';

export const huggingfaceEmbeddingProvider: EmbeddingProviderFactory = (config: EmbeddingConfig) => {
  return {
    name: 'huggingface',
    
    async generateEmbedding(request: EmbeddingRequest): Promise<EmbeddingResponse> {
      const startTime = Date.now();
      
      try {
        // Get API key from config or environment
        const apiKey = config.apiKey || 
          Deno.env.get('DEFAULT_HUGGINGFACE_KEY') || 
          Deno.env.get('HUGGINGFACE_API_KEY');
        
        if (!apiKey) {
          throw new Error('HuggingFace API key is required for embedding generation');
        }
        
        // Default to a popular sentence transformer model
        const model = config.model || 'sentence-transformers/all-MiniLM-L6-v2';
        const texts = Array.isArray(request.input) ? request.input : [request.input];
        
        // Prepare request payload
        const payload = {
          inputs: texts,
          options: {
            wait_for_model: true,
            use_cache: true
          }
        };
        
        // Make API request
        const response = await fetch(`https://api-inference.huggingface.co/pipeline/feature-extraction/${model}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`HuggingFace API Error: ${error}`);
        }
        
        const data = await response.json();
        const processingTime = Date.now() - startTime;
        
        // HuggingFace returns different formats, normalize to our format
        let embeddings;
        if (Array.isArray(request.input)) {
          // Multiple inputs, data should be array of arrays
          embeddings = Array.isArray(data[0]) ? data : [data];
        } else {
          // Single input, take first embedding
          embeddings = Array.isArray(data[0]) ? data[0] : data;
        }
        
        return {
          success: true,
          provider: 'huggingface',
          model: model,
          processingTime,
          embeddings: embeddings,
          usage: {
            promptTokens: texts.join(' ').split(' ').length, // Approximate token count
            totalTokens: texts.join(' ').split(' ').length
          }
        };
        
      } catch (error) {
        const processingTime = Date.now() - startTime;
        return {
          success: false,
          processingTime,
          error: error instanceof Error ? error.message : String(error),
          embeddings: []
        };
      }
    }
  };
}; 