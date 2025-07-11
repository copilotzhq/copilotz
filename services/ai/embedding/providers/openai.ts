import type { 
  EmbeddingProviderFactory, 
  EmbeddingRequest, 
  EmbeddingResponse, 
  EmbeddingConfig 
} from '../../types.ts';

export const openaiEmbeddingProvider: EmbeddingProviderFactory = (config: EmbeddingConfig) => {
  return {
    name: 'openai',
    
    async generateEmbedding(request: EmbeddingRequest): Promise<EmbeddingResponse> {
      const startTime = Date.now();
      
      try {
        // Get API key from config or environment
        const apiKey = config.apiKey || 
          Deno.env.get('DEFAULT_OPENAI_KEY') || 
          Deno.env.get('OPENAI_API_KEY');
        
        if (!apiKey) {
          throw new Error('OpenAI API key is required for embedding generation');
        }
        
        // Prepare request payload
        const payload = {
          model: config.model || 'text-embedding-3-small',
          input: request.input,
          encoding_format: config.encodingFormat || 'float',
          ...(config.dimensions && { dimensions: config.dimensions })
        };
        
        // Make API request
        const response = await fetch('https://api.openai.com/v1/embeddings', {
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
          model: config.model || 'text-embedding-3-small',
          processingTime,
          embeddings: Array.isArray(request.input) 
            ? data.data.map((item: any) => item.embedding)
            : data.data[0].embedding,
          usage: {
            promptTokens: data.usage?.prompt_tokens || 0,
            totalTokens: data.usage?.total_tokens || 0
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