import type { ProviderName } from './types.ts';
import { isProviderAvailable, getAvailableProviders } from './providers/index.ts';

interface RequestContext {
  url: string;
  params: Record<string, any>;
  query?: Record<string, any>;
}

interface ModelsContext {
  configs: {
    findOne(query: { name: string }): Promise<{ value?: Record<string, any> } | null>;
  };
}

export default async function middleware(req: RequestContext & { models?: ModelsContext }) {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const pathSegments = pathname.split('/').filter(Boolean);
  
  // Extract provider from different sources:
  // 1. URL path: /api/ai/chat/openai
  // 2. Query parameter: ?provider=openai
  // 3. Request body (will be handled in the endpoint)
  let provider: ProviderName | undefined;
  
  // Check if provider is in URL path (last segment)
  const lastSegment = pathSegments[pathSegments.length - 1];
  if (lastSegment && lastSegment !== 'chat' && isProviderAvailable(lastSegment)) {
    provider = lastSegment as ProviderName;
  }
  
  // Check query parameters
  if (!provider && url.searchParams.has('provider')) {
    const queryProvider = url.searchParams.get('provider');
    if (queryProvider && isProviderAvailable(queryProvider)) {
      provider = queryProvider as ProviderName;
    }
  }

  // If provider found, validate and load config
  if (provider) {
    // Load provider configuration if models context is available
    let config = {};
    if (req.models?.configs) {
      try {
        const configDoc = await req.models.configs.findOne({ 
          name: `${provider.toUpperCase()}_CREDENTIALS` 
        });
        config = configDoc?.value || {};
      } catch (error) {
        console.warn(`Failed to load config for ${provider}:`, error);
      }
    }

    // Add provider and config to request params
    req.params = {
      ...req.params,
      provider,
      config: { ...req.params.config, ...config },
    };
  }

  // Add query parameters to params for easy access
  if (url.searchParams.size > 0) {
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    req.params.query = query;
  }

  return req;
} 