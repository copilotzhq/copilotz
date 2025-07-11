/**
 * Agentic Tool Framework - HTTP API Tool
 * Comprehensive HTTP client with authentication and full method support
 */

import type { ToolDefinition } from '../types.ts';
import { SchemaBuilders } from '../validation.ts';

// =============================================================================
// HTTP API TOOL
// =============================================================================

/**
 * HTTP API Call Tool
 * Makes HTTP requests with comprehensive authentication and options support
 */
export const httpApiTool: ToolDefinition = {
  id: 'http-api',
  name: 'HTTP API Call',
  description: 'Make HTTP requests to external APIs with authentication support',
  version: '1.0.0',
  category: 'integration',
  type: 'api',
  
  input: {
    schema: SchemaBuilders.object({
      url: SchemaBuilders.string({
        description: 'URL to make the request to',
        pattern: '^https?://.*',
        minLength: 1,
        maxLength: 2000
      }),
      method: SchemaBuilders.string({
        description: 'HTTP method to use',
        enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
        default: 'GET'
      }),
      headers: SchemaBuilders.object({
        'Content-Type': { type: 'string' },
        'Authorization': { type: 'string' },
        'User-Agent': { type: 'string' },
        'Accept': { type: 'string' },
        'Accept-Language': { type: 'string' },
        'Cache-Control': { type: 'string' },
        'X-API-Key': { type: 'string' }
      }),
      body: {
        description: 'Request body (for POST, PUT, PATCH)',
        oneOf: [
          { type: 'string' },
          { type: 'object' },
          { type: 'array' }
        ]
      },
      queryParams: SchemaBuilders.object({
        description: 'Query parameters to append to URL'
      }),
      authentication: SchemaBuilders.object({
        type: SchemaBuilders.string({
          description: 'Authentication type',
          enum: ['none', 'bearer', 'basic', 'api-key', 'oauth2']
        }),
        token: SchemaBuilders.string({
          description: 'Authentication token or API key'
        }),
        username: SchemaBuilders.string({
          description: 'Username for basic auth'
        }),
        password: SchemaBuilders.string({
          description: 'Password for basic auth'
        }),
        apiKeyHeader: SchemaBuilders.string({
          description: 'Header name for API key authentication',
          default: 'X-API-Key'
        }),
        apiKeyLocation: SchemaBuilders.string({
          description: 'Where to place the API key',
          enum: ['header', 'query'],
          default: 'header'
        })
      }),
      options: SchemaBuilders.object({
        timeout: SchemaBuilders.number({
          description: 'Request timeout in milliseconds',
          minimum: 1000,
          maximum: 300000,
          default: 30000
        }),
        followRedirects: SchemaBuilders.boolean({
          description: 'Follow HTTP redirects',
          default: true
        }),
        maxRedirects: SchemaBuilders.number({
          description: 'Maximum number of redirects to follow',
          minimum: 0,
          maximum: 10,
          default: 5
        }),
        validateStatus: SchemaBuilders.boolean({
          description: 'Validate HTTP status codes',
          default: true
        }),
        retries: SchemaBuilders.number({
          description: 'Number of retry attempts',
          minimum: 0,
          maximum: 5,
          default: 0
        }),
        retryDelay: SchemaBuilders.number({
          description: 'Delay between retries in milliseconds',
          minimum: 100,
          maximum: 10000,
          default: 1000
        })
      })
    }, ['url']),
    required: ['url']
  },
  
  output: {
    schema: SchemaBuilders.object({
      status: { type: 'number' },
      statusText: { type: 'string' },
      headers: { type: 'object' },
      data: {
        description: 'Response data',
        oneOf: [
          { type: 'string' },
          { type: 'object' },
          { type: 'array' }
        ]
      },
      url: { type: 'string' },
      method: { type: 'string' },
      duration: { type: 'number' },
      success: { type: 'boolean' },
      error: { type: 'string' },
      redirects: { type: 'number' },
      size: { type: 'number' }
    }, ['status', 'statusText', 'headers', 'data', 'url', 'method', 'duration', 'success'])
  },
  
  implementation: {
    type: 'function',
    handler: async (input: any) => {
      const startTime = Date.now();
      
      try {
        const result = await makeHttpRequest(input);
        
        return {
          ...result,
          duration: Date.now() - startTime,
          success: true
        };
      } catch (error) {
        const errorResult = {
          status: error.status || 0,
          statusText: error.statusText || 'Request Failed',
          headers: error.headers || {},
          data: null,
          url: input.url,
          method: input.method || 'GET',
          duration: Date.now() - startTime,
          success: false,
          error: error.message || String(error),
          redirects: 0,
          size: 0
        };
        
        // Return error result instead of throwing
        return errorResult;
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
    timeout: 300000, // 5 minutes
    resourceLimits: {
      maxMemoryMB: 512,
      maxExecutionTimeMs: 300000,
      maxConcurrentExecutions: 20
    }
  },
  
  metadata: {
    author: 'Copilotz',
    tags: ['api', 'http', 'request', 'client', 'integration'],
    deprecated: false,
    experimental: false
  }
};

// =============================================================================
// HTTP CLIENT IMPLEMENTATION
// =============================================================================

/**
 * HTTP request configuration
 */
interface HttpRequestConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  queryParams?: Record<string, string>;
  authentication?: {
    type?: string;
    token?: string;
    username?: string;
    password?: string;
    apiKeyHeader?: string;
    apiKeyLocation?: string;
  };
  options?: {
    timeout?: number;
    followRedirects?: boolean;
    maxRedirects?: number;
    validateStatus?: boolean;
    retries?: number;
    retryDelay?: number;
  };
}

/**
 * HTTP response structure
 */
interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: any;
  url: string;
  method: string;
  redirects: number;
  size: number;
}

/**
 * Make HTTP request with comprehensive options
 */
async function makeHttpRequest(config: HttpRequestConfig): Promise<HttpResponse> {
  const {
    url,
    method = 'GET',
    headers = {},
    body,
    queryParams = {},
    authentication = {},
    options = {}
  } = config;

  // Build URL with query parameters
  const finalUrl = buildUrl(url, queryParams);
  
  // Build headers with authentication
  const finalHeaders = buildHeaders(headers, authentication);
  
  // Build request options
  const fetchOptions: RequestInit = {
    method: method.toUpperCase(),
    headers: finalHeaders,
    signal: AbortSignal.timeout(options.timeout || 30000),
    redirect: options.followRedirects !== false ? 'follow' : 'manual'
  };

  // Add body for applicable methods
  if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && body !== undefined) {
    fetchOptions.body = prepareBody(body, finalHeaders);
  }

  // Implement retry logic
  const maxRetries = options.retries || 0;
  const retryDelay = options.retryDelay || 1000;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(finalUrl, fetchOptions);
      
      // Parse response
      const result = await parseResponse(response, finalUrl, method);
      
      // Validate status if enabled
      if (options.validateStatus !== false && !isSuccessStatus(response.status)) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      return result;
      
    } catch (error) {
      // If this is the last attempt, throw the error
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  
  throw new Error('Max retries exceeded');
}

/**
 * Build URL with query parameters
 */
function buildUrl(baseUrl: string, queryParams: Record<string, string>): string {
  const url = new URL(baseUrl);
  
  Object.entries(queryParams).forEach(([key, value]) => {
    url.searchParams.append(key, String(value));
  });
  
  return url.toString();
}

/**
 * Build headers with authentication
 */
function buildHeaders(
  baseHeaders: Record<string, string>,
  auth: HttpRequestConfig['authentication'] = {}
): Record<string, string> {
  const headers = { ...baseHeaders };
  
  // Set default content type if not specified
  if (!headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }
  
  // Set user agent if not specified
  if (!headers['User-Agent'] && !headers['user-agent']) {
    headers['User-Agent'] = 'Copilotz-Agent/1.0';
  }
  
  // Apply authentication
  switch (auth.type) {
    case 'bearer':
      if (auth.token) {
        headers['Authorization'] = `Bearer ${auth.token}`;
      }
      break;
      
    case 'basic':
      if (auth.username && auth.password) {
        const credentials = btoa(`${auth.username}:${auth.password}`);
        headers['Authorization'] = `Basic ${credentials}`;
      }
      break;
      
    case 'api-key':
      if (auth.token) {
        const headerName = auth.apiKeyHeader || 'X-API-Key';
        if (auth.apiKeyLocation === 'header' || !auth.apiKeyLocation) {
          headers[headerName] = auth.token;
        }
      }
      break;
      
    case 'oauth2':
      if (auth.token) {
        headers['Authorization'] = `Bearer ${auth.token}`;
      }
      break;
  }
  
  return headers;
}

/**
 * Prepare request body
 */
function prepareBody(body: any, headers: Record<string, string>): string | FormData | URLSearchParams {
  if (body === null || body === undefined) {
    return '';
  }
  
  const contentType = headers['Content-Type'] || headers['content-type'] || '';
  
  if (contentType.includes('application/json')) {
    return JSON.stringify(body);
  } else if (contentType.includes('application/x-www-form-urlencoded')) {
    if (typeof body === 'object') {
      const params = new URLSearchParams();
      Object.entries(body).forEach(([key, value]) => {
        params.append(key, String(value));
      });
      return params;
    }
    return String(body);
  } else if (contentType.includes('multipart/form-data')) {
    if (typeof body === 'object') {
      const formData = new FormData();
      Object.entries(body).forEach(([key, value]) => {
        formData.append(key, String(value));
      });
      return formData;
    }
    return String(body);
  } else {
    // Default to string
    return typeof body === 'string' ? body : JSON.stringify(body);
  }
}

/**
 * Parse HTTP response
 */
async function parseResponse(response: Response, url: string, method: string): Promise<HttpResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  
  // Determine response size
  const contentLength = response.headers.get('content-length');
  const size = contentLength ? parseInt(contentLength, 10) : 0;
  
  // Parse response data
  let data: any = null;
  const contentType = response.headers.get('content-type') || '';
  
  try {
    if (contentType.includes('application/json') || contentType.includes('application/x-javascript')) {
      data = await response.json();
    } else if (contentType.includes('text/')) {
      data = await response.text();
    } else if (contentType.includes('application/xml') || contentType.includes('text/xml')) {
      data = await response.text();
    } else {
      // For binary data, return as text for now
      data = await response.text();
    }
  } catch (error) {
    // If parsing fails, try to get as text
    try {
      data = await response.text();
    } catch {
      data = null;
    }
  }
  
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    data,
    url,
    method,
    redirects: response.redirected ? 1 : 0,
    size
  };
}

/**
 * Check if status code indicates success
 */
function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Create a simple GET request
 */
export async function httpGet(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
  return makeHttpRequest({
    url,
    method: 'GET',
    headers
  });
}

/**
 * Create a simple POST request
 */
export async function httpPost(
  url: string,
  body?: any,
  headers?: Record<string, string>
): Promise<HttpResponse> {
  return makeHttpRequest({
    url,
    method: 'POST',
    body,
    headers
  });
}

/**
 * Create a simple PUT request
 */
export async function httpPut(
  url: string,
  body?: any,
  headers?: Record<string, string>
): Promise<HttpResponse> {
  return makeHttpRequest({
    url,
    method: 'PUT',
    body,
    headers
  });
}

/**
 * Create a simple DELETE request
 */
export async function httpDelete(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
  return makeHttpRequest({
    url,
    method: 'DELETE',
    headers
  });
}

/**
 * Create an authenticated request
 */
export async function httpWithAuth(
  url: string,
  method: string,
  token: string,
  authType: 'bearer' | 'api-key' = 'bearer',
  body?: any
): Promise<HttpResponse> {
  return makeHttpRequest({
    url,
    method,
    body,
    authentication: {
      type: authType,
      token
    }
  });
}

/**
 * Create a request with basic auth
 */
export async function httpWithBasicAuth(
  url: string,
  method: string,
  username: string,
  password: string,
  body?: any
): Promise<HttpResponse> {
  return makeHttpRequest({
    url,
    method,
    body,
    authentication: {
      type: 'basic',
      username,
      password
    }
  });
}

// =============================================================================
// EXPORTS
// =============================================================================

export default httpApiTool;
export { makeHttpRequest, type HttpRequestConfig, type HttpResponse }; 