import type { 
  EmbeddingProviderFactory, 
  EmbeddingRequest, 
  EmbeddingResponse, 
  EmbeddingConfig 
} from '../../types.ts';

export const cohereEmbeddingProvider: EmbeddingProviderFactory = (config: EmbeddingConfig) => {
  return {
    name: 'cohere',
    
    async generateEmbedding(request: EmbeddingRequest): Promise<EmbeddingResponse> {
      const startTime = Date.now();
      
      try {
        // Get API key from config or environment
        const apiKey = config.apiKey || 
          Deno.env.get('DEFAULT_COHERE_KEY') || 
          Deno.env.get('COHERE_API_KEY');
        
        if (!apiKey) {
          throw new Error('Cohere API key is required for embedding generation');
        }
        
        // Cohere requires array input, convert string to array if needed
        const texts = Array.isArray(request.input) ? request.input : [request.input];
        
        // Prepare request payload
        const payload = {
          model: config.model || 'embed-english-v3.0',
          texts: texts,
          input_type: 'search_document', // Default input type
          embedding_types: ['float'], // Cohere specific
          truncate: 'END' // Cohere specific truncation
        };
        
        // Make API request
        const response = await fetch('https://api.cohere.ai/v1/embed', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Cohere-Version': '2022-12-06' // Required for Cohere API
          },
          body: JSON.stringify(payload),
        });
        
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Cohere API Error: ${error}`);
        }
        
        const data = await response.json();
        const processingTime = Date.now() - startTime;
        
        return {
          success: true,
          provider: 'cohere',
          model: config.model || 'embed-english-v3.0',
          processingTime,
          embeddings: Array.isArray(request.input) 
            ? data.embeddings
            : data.embeddings[0],
          usage: {
            promptTokens: data.meta?.billed_units?.input_tokens || texts.join(' ').split(' ').length,
            totalTokens: data.meta?.billed_units?.input_tokens || texts.join(' ').split(' ').length
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