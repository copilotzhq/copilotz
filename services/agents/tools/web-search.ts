/**
 * Agentic Tool Framework - Web Search Tool
 * Comprehensive web search integration with multiple providers
 */

import type { ToolDefinition } from '../types.ts';
import { SchemaBuilders } from '../validation.ts';
import { makeHttpRequest } from './api.ts';

// =============================================================================
// WEB SEARCH TOOL
// =============================================================================

/**
 * Web Search Tool
 * Searches the web using various search engines and APIs
 */
export const webSearchTool: ToolDefinition = {
  id: 'web-search',
  name: 'Web Search',
  description: 'Search the web using various search engines and APIs',
  version: '1.0.0',
  category: 'search',
  type: 'web_search',
  
  input: {
    schema: SchemaBuilders.object({
      query: SchemaBuilders.string({
        description: 'Search query to find information on the web',
        minLength: 1,
        maxLength: 500
      }),
      provider: SchemaBuilders.string({
        description: 'Search provider to use',
        enum: ['google', 'bing', 'duckduckgo', 'serper', 'searchapi'],
        default: 'duckduckgo'
      }),
      maxResults: SchemaBuilders.number({
        description: 'Maximum number of results to return',
        minimum: 1,
        maximum: 50,
        default: 10
      }),
      country: SchemaBuilders.string({
        description: 'Country code for localized results (e.g., "us", "uk", "de")',
        pattern: '^[a-z]{2}$',
        default: 'us'
      }),
      language: SchemaBuilders.string({
        description: 'Language code for results (e.g., "en", "es", "fr")',
        pattern: '^[a-z]{2}$',
        default: 'en'
      }),
      safeSearch: SchemaBuilders.string({
        description: 'Safe search level',
        enum: ['off', 'moderate', 'strict'],
        default: 'moderate'
      }),
      searchType: SchemaBuilders.string({
        description: 'Type of search to perform',
        enum: ['web', 'news', 'images', 'videos', 'academic'],
        default: 'web'
      }),
      apiKey: SchemaBuilders.string({
        description: 'API key for paid search services'
      }),
      options: SchemaBuilders.object({
        includeSnippets: SchemaBuilders.boolean({
          description: 'Include content snippets in results',
          default: true
        }),
        includeThumbnails: SchemaBuilders.boolean({
          description: 'Include thumbnail images where available',
          default: false
        }),
        freshness: SchemaBuilders.string({
          description: 'Filter by content freshness',
          enum: ['any', 'day', 'week', 'month', 'year'],
          default: 'any'
        }),
        site: SchemaBuilders.string({
          description: 'Limit search to specific website (e.g., "wikipedia.org")'
        }),
        excludeSites: SchemaBuilders.array(SchemaBuilders.string({
          description: 'Sites to exclude from results'
        }))
      })
    }, ['query']),
    required: ['query']
  },
  
  output: {
    schema: SchemaBuilders.object({
      results: SchemaBuilders.array(SchemaBuilders.object({
        title: { type: 'string' },
        url: { type: 'string' },
        snippet: { type: 'string' },
        displayUrl: { type: 'string' },
        date: { type: 'string' },
        thumbnail: { type: 'string' },
        source: { type: 'string' },
        rank: { type: 'number' }
      })),
      query: { type: 'string' },
      provider: { type: 'string' },
      total: { type: 'number' },
      searchTime: { type: 'number' },
      suggestions: SchemaBuilders.array({ type: 'string' }),
      relatedSearches: SchemaBuilders.array({ type: 'string' })
    }, ['results', 'query', 'provider', 'total'])
  },
  
  implementation: {
    type: 'function',
    handler: async (input: any) => {
      const startTime = Date.now();
      
      try {
        const results = await performWebSearch(input);
        
        return {
          ...results,
          searchTime: Date.now() - startTime
        };
      } catch (error) {
        return {
          results: [],
          query: input.query,
          provider: input.provider || 'duckduckgo',
          total: 0,
          searchTime: Date.now() - startTime,
          suggestions: [],
          relatedSearches: [],
          error: error.message || String(error)
        };
      }
    }
  },
  
  permissions: {
    networkAccess: true,
    fileSystemAccess: false,
    requiresAuthentication: false
  },
  
  execution: {
    environment: 'main',
    timeout: 30000,
    resourceLimits: {
      maxMemoryMB: 256,
      maxExecutionTimeMs: 30000,
      maxConcurrentExecutions: 10
    }
  },
  
  metadata: {
    author: 'Copilotz',
    tags: ['search', 'web', 'google', 'bing', 'duckduckgo', 'internet'],
    deprecated: false,
    experimental: false
  }
};

// =============================================================================
// SEARCH IMPLEMENTATION
// =============================================================================

/**
 * Search configuration
 */
interface SearchConfig {
  query: string;
  provider?: string;
  maxResults?: number;
  country?: string;
  language?: string;
  safeSearch?: string;
  searchType?: string;
  apiKey?: string;
  options?: {
    includeSnippets?: boolean;
    includeThumbnails?: boolean;
    freshness?: string;
    site?: string;
    excludeSites?: string[];
  };
}

/**
 * Search result structure
 */
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
  date?: string;
  thumbnail?: string;
  source?: string;
  rank: number;
}

/**
 * Search response structure
 */
interface SearchResponse {
  results: SearchResult[];
  query: string;
  provider: string;
  total: number;
  suggestions?: string[];
  relatedSearches?: string[];
}

/**
 * Perform web search using specified provider
 */
async function performWebSearch(config: SearchConfig): Promise<SearchResponse> {
  const provider = config.provider || 'duckduckgo';
  
  switch (provider) {
    case 'google':
      return searchGoogle(config);
    case 'bing':
      return searchBing(config);
    case 'duckduckgo':
      return searchDuckDuckGo(config);
    case 'serper':
      return searchSerper(config);
    case 'searchapi':
      return searchSearchAPI(config);
    default:
      throw new Error(`Unsupported search provider: ${provider}`);
  }
}

/**
 * Search using Google Custom Search API
 */
async function searchGoogle(config: SearchConfig): Promise<SearchResponse> {
  if (!config.apiKey) {
    throw new Error('Google Custom Search requires an API key');
  }
  
  const params = new URLSearchParams({
    key: config.apiKey,
    cx: '017576662512468239146:omuauf_lfve', // Public search engine ID
    q: config.query,
    num: String(config.maxResults || 10),
    gl: config.country || 'us',
    hl: config.language || 'en',
    safe: config.safeSearch === 'strict' ? 'active' : 'off'
  });
  
  if (config.options?.site) {
    params.set('siteSearch', config.options.site);
  }
  
  const url = `https://www.googleapis.com/customsearch/v1?${params}`;
  
  const response = await makeHttpRequest({
    url,
    method: 'GET',
    headers: {
      'User-Agent': 'Copilotz-Agent/1.0'
    }
  });
  
  if (!response.data || !response.data.items) {
    return {
      results: [],
      query: config.query,
      provider: 'google',
      total: 0,
      suggestions: [],
      relatedSearches: []
    };
  }
  
  const results: SearchResult[] = response.data.items.map((item: any, index: number) => ({
    title: item.title || '',
    url: item.link || '',
    snippet: item.snippet || '',
    displayUrl: item.displayLink || '',
    date: item.pagemap?.metatags?.[0]?.['article:published_time'] || '',
    thumbnail: item.pagemap?.cse_thumbnail?.[0]?.src || '',
    source: item.displayLink || '',
    rank: index + 1
  }));
  
  return {
    results,
    query: config.query,
    provider: 'google',
    total: results.length,
    suggestions: response.data.spelling?.correctedQuery ? [response.data.spelling.correctedQuery] : [],
    relatedSearches: response.data.queries?.relatedSearches?.map((q: any) => q.title) || []
  };
}

/**
 * Search using Bing Web Search API
 */
async function searchBing(config: SearchConfig): Promise<SearchResponse> {
  if (!config.apiKey) {
    throw new Error('Bing Web Search requires an API key');
  }
  
  const params = new URLSearchParams({
    q: config.query,
    count: String(config.maxResults || 10),
    mkt: `${config.language || 'en'}-${config.country || 'us'}`,
    safeSearch: config.safeSearch === 'strict' ? 'Strict' : 'Moderate'
  });
  
  if (config.options?.site) {
    params.set('q', `${config.query} site:${config.options.site}`);
  }
  
  const url = `https://api.bing.microsoft.com/v7.0/search?${params}`;
  
  const response = await makeHttpRequest({
    url,
    method: 'GET',
    headers: {
      'Ocp-Apim-Subscription-Key': config.apiKey,
      'User-Agent': 'Copilotz-Agent/1.0'
    }
  });
  
  if (!response.data || !response.data.webPages || !response.data.webPages.value) {
    return {
      results: [],
      query: config.query,
      provider: 'bing',
      total: 0,
      suggestions: [],
      relatedSearches: []
    };
  }
  
  const results: SearchResult[] = response.data.webPages.value.map((item: any, index: number) => ({
    title: item.name || '',
    url: item.url || '',
    snippet: item.snippet || '',
    displayUrl: item.displayUrl || '',
    date: item.dateLastCrawled || '',
    thumbnail: item.thumbnail?.contentUrl || '',
    source: item.displayUrl || '',
    rank: index + 1
  }));
  
  return {
    results,
    query: config.query,
    provider: 'bing',
    total: results.length,
    suggestions: response.data.queryContext?.alteredQuery ? [response.data.queryContext.alteredQuery] : [],
    relatedSearches: response.data.relatedSearches?.value?.map((q: any) => q.text) || []
  };
}

/**
 * Search using DuckDuckGo Instant Answer API
 */
async function searchDuckDuckGo(config: SearchConfig): Promise<SearchResponse> {
  // DuckDuckGo doesn't have a direct web search API, so we'll use their instant answer API
  // and supplement with HTML scraping for web results
  
  const params = new URLSearchParams({
    q: config.query,
    format: 'json',
    no_html: '1',
    skip_disambig: '1'
  });
  
  const url = `https://api.duckduckgo.com/?${params}`;
  
  const response = await makeHttpRequest({
    url,
    method: 'GET',
    headers: {
      'User-Agent': 'Copilotz-Agent/1.0'
    }
  });
  
  const results: SearchResult[] = [];
  
  // Parse DuckDuckGo response
  if (response.data) {
    const data = response.data;
    
    // Add abstract if available
    if (data.Abstract) {
      results.push({
        title: data.Heading || config.query,
        url: data.AbstractURL || '',
        snippet: data.Abstract,
        displayUrl: data.AbstractSource || '',
        source: data.AbstractSource || '',
        rank: 1
      });
    }
    
    // Add related topics
    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
      data.RelatedTopics.forEach((topic: any, index: number) => {
        if (topic.Text && topic.FirstURL) {
          results.push({
            title: topic.Text.split(' - ')[0] || '',
            url: topic.FirstURL,
            snippet: topic.Text,
            displayUrl: topic.FirstURL,
            source: 'DuckDuckGo',
            rank: index + 2
          });
        }
      });
    }
    
    // Add results from results array
    if (data.Results && Array.isArray(data.Results)) {
      data.Results.forEach((result: any, index: number) => {
        results.push({
          title: result.Text || '',
          url: result.FirstURL || '',
          snippet: result.Text || '',
          displayUrl: result.FirstURL || '',
          source: 'DuckDuckGo',
          rank: results.length + 1
        });
      });
    }
  }
  
  // If we don't have enough results, try alternative approach
  if (results.length === 0) {
    // Use HTML scraping as fallback (simplified)
    const htmlResponse = await makeHttpRequest({
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(config.query)}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    // Basic HTML parsing for results (simplified)
    if (htmlResponse.data && typeof htmlResponse.data === 'string') {
      const html = htmlResponse.data;
      const resultMatches = html.match(/<div class="result__body">[\s\S]*?<\/div>/g) || [];
      
      resultMatches.slice(0, config.maxResults || 10).forEach((match, index) => {
        const titleMatch = match.match(/<a[^>]*class="result__a"[^>]*>([^<]*)<\/a>/);
        const urlMatch = match.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>/);
        const snippetMatch = match.match(/<a[^>]*class="result__snippet"[^>]*>([^<]*)<\/a>/);
        
        if (titleMatch && urlMatch) {
          results.push({
            title: titleMatch[1].trim(),
            url: urlMatch[1].trim(),
            snippet: snippetMatch ? snippetMatch[1].trim() : '',
            displayUrl: urlMatch[1].trim(),
            source: 'DuckDuckGo',
            rank: index + 1
          });
        }
      });
    }
  }
  
  return {
    results: results.slice(0, config.maxResults || 10),
    query: config.query,
    provider: 'duckduckgo',
    total: results.length,
    suggestions: [],
    relatedSearches: []
  };
}

/**
 * Search using Serper API
 */
async function searchSerper(config: SearchConfig): Promise<SearchResponse> {
  if (!config.apiKey) {
    throw new Error('Serper API requires an API key');
  }
  
  const requestBody = {
    q: config.query,
    num: config.maxResults || 10,
    gl: config.country || 'us',
    hl: config.language || 'en'
  };
  
  if (config.options?.site) {
    requestBody.q += ` site:${config.options.site}`;
  }
  
  const response = await makeHttpRequest({
    url: 'https://google.serper.dev/search',
    method: 'POST',
    headers: {
      'X-API-KEY': config.apiKey,
      'Content-Type': 'application/json'
    },
    body: requestBody
  });
  
  if (!response.data || !response.data.organic) {
    return {
      results: [],
      query: config.query,
      provider: 'serper',
      total: 0,
      suggestions: [],
      relatedSearches: []
    };
  }
  
  const results: SearchResult[] = response.data.organic.map((item: any, index: number) => ({
    title: item.title || '',
    url: item.link || '',
    snippet: item.snippet || '',
    displayUrl: item.displayLink || '',
    date: item.date || '',
    thumbnail: item.thumbnail || '',
    source: item.displayLink || '',
    rank: index + 1
  }));
  
  return {
    results,
    query: config.query,
    provider: 'serper',
    total: results.length,
    suggestions: response.data.searchInformation?.queryDisplayed ? [response.data.searchInformation.queryDisplayed] : [],
    relatedSearches: response.data.relatedSearches?.map((q: any) => q.query) || []
  };
}

/**
 * Search using SearchAPI
 */
async function searchSearchAPI(config: SearchConfig): Promise<SearchResponse> {
  if (!config.apiKey) {
    throw new Error('SearchAPI requires an API key');
  }
  
  const params = new URLSearchParams({
    api_key: config.apiKey,
    q: config.query,
    num: String(config.maxResults || 10),
    gl: config.country || 'us',
    hl: config.language || 'en'
  });
  
  if (config.options?.site) {
    params.set('q', `${config.query} site:${config.options.site}`);
  }
  
  const url = `https://www.searchapi.io/api/v1/search?${params}`;
  
  const response = await makeHttpRequest({
    url,
    method: 'GET',
    headers: {
      'User-Agent': 'Copilotz-Agent/1.0'
    }
  });
  
  if (!response.data || !response.data.organic_results) {
    return {
      results: [],
      query: config.query,
      provider: 'searchapi',
      total: 0,
      suggestions: [],
      relatedSearches: []
    };
  }
  
  const results: SearchResult[] = response.data.organic_results.map((item: any, index: number) => ({
    title: item.title || '',
    url: item.link || '',
    snippet: item.snippet || '',
    displayUrl: item.displayed_link || '',
    date: item.date || '',
    thumbnail: item.thumbnail || '',
    source: item.displayed_link || '',
    rank: index + 1
  }));
  
  return {
    results,
    query: config.query,
    provider: 'searchapi',
    total: results.length,
    suggestions: [],
    relatedSearches: response.data.related_searches?.map((q: any) => q.query) || []
  };
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Quick web search using default provider
 */
export async function quickSearch(query: string, maxResults = 10): Promise<SearchResponse> {
  return performWebSearch({
    query,
    provider: 'duckduckgo',
    maxResults
  });
}

/**
 * Search for news articles
 */
export async function searchNews(query: string, maxResults = 10): Promise<SearchResponse> {
  return performWebSearch({
    query,
    provider: 'duckduckgo',
    searchType: 'news',
    maxResults
  });
}

/**
 * Search within a specific website
 */
export async function searchSite(query: string, site: string, maxResults = 10): Promise<SearchResponse> {
  return performWebSearch({
    query,
    provider: 'duckduckgo',
    maxResults,
    options: {
      site
    }
  });
}

/**
 * Search with safe search enabled
 */
export async function safeSearch(query: string, maxResults = 10): Promise<SearchResponse> {
  return performWebSearch({
    query,
    provider: 'duckduckgo',
    maxResults,
    safeSearch: 'strict'
  });
}

// =============================================================================
// EXPORTS
// =============================================================================

export default webSearchTool;
export { performWebSearch, type SearchConfig, type SearchResult, type SearchResponse }; 