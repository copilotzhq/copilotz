// =============================================================================
// REQUEST CONNECTOR - HTTP client based on fetch with streaming support
// =============================================================================

export interface RequestConfig {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  signal?: AbortSignal;
  retries?: number;
  retryDelay?: number;
  validateStatus?: (status: number) => boolean;
  stream?: boolean;
  onStream?: (chunk: string) => void | Promise<void>;
}

export interface RequestResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
  ok: boolean;
}

export interface StreamResponse {
  status: number;
  statusText: string;
  headers: Headers;
  ok: boolean;
  stream: ReadableStream<Uint8Array>;
  text: () => AsyncGenerator<string, void, unknown>;
  json: () => AsyncGenerator<unknown, void, unknown>;
}

export interface RequestError extends Error {
  status?: number;
  statusText?: string;
  response?: Response;
  data?: unknown;
}

/**
 * Makes an HTTP request using fetch with enhanced features including streaming
 */
export async function request<T = unknown>(
  url: string,
  config: RequestConfig = {}
): Promise<RequestResponse<T> | StreamResponse> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = 300000,
    signal,
    retries = 0,
    retryDelay = 1000,
    validateStatus = (status) => status >= 200 && status < 300,
    stream = false,
    onStream,
  } = config;

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;

  // Combine signals if provided
  const combinedSignal = signal
    ? combineAbortSignals([signal, controller.signal])
    : controller.signal;

  // Prepare request options
  const fetchOptions: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    signal: combinedSignal,
  };

  // Add body if present
  if (body !== undefined) {
    if (typeof body === 'string') {
      fetchOptions.body = body;
    } else if (body instanceof FormData || body instanceof URLSearchParams) {
      fetchOptions.body = body;
      // Remove Content-Type for FormData (browser sets it with boundary)
      if (body instanceof FormData) {
        delete (fetchOptions.headers as Record<string, string>)['Content-Type'];
      }
    } else {
      fetchOptions.body = JSON.stringify(body);
    }
  }

  let lastError: RequestError | null = null;
  let attempt = 0;

  while (attempt <= retries) {
    try {
      const response = await fetch(url, fetchOptions);

      if (timeoutId) clearTimeout(timeoutId);

      // Check if status is valid
      if (!validateStatus(response.status)) {
        const error = new Error(`Request failed with status ${response.status}`) as RequestError;
        error.status = response.status;
        error.statusText = response.statusText;
        error.response = response;

        // Try to parse error response
        try {
          const contentType = response.headers.get('content-type');
          if (contentType?.includes('application/json')) {
            error.data = await response.json();
          } else {
            error.data = await response.text();
          }
        } catch {
          // Ignore parse errors
        }

        throw error;
      }

      // Handle streaming response
      if (stream || onStream) {
        if (!response.body) {
          throw new Error('Response body is not available for streaming');
        }

        const streamResponse: StreamResponse = {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          ok: response.ok,
          stream: response.body,
          text: async function* () {
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                if (onStream) {
                  await onStream(chunk);
                }
                yield chunk;
              }
            } finally {
              reader.releaseLock();
            }
          },
          json: async function* () {
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Try to parse complete JSON objects from buffer
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep incomplete line in buffer

                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed) continue;

                  // Handle SSE format (data: {...})
                  const jsonStr = trimmed.startsWith('data: ')
                    ? trimmed.slice(6)
                    : trimmed;

                  if (jsonStr === '[DONE]') continue;

                  try {
                    const parsed = JSON.parse(jsonStr);
                    if (onStream) {
                      await onStream(jsonStr);
                    }
                    yield parsed;
                  } catch {
                    // Skip invalid JSON
                  }
                }
              }

              // Process remaining buffer
              if (buffer.trim()) {
                try {
                  const parsed = JSON.parse(buffer.trim());
                  yield parsed;
                } catch {
                  // Skip invalid JSON
                }
              }
            } finally {
              reader.releaseLock();
            }
          },
        };

        return streamResponse;
      }

      // Parse non-streaming response data
      let data: T;
      const contentType = response.headers.get('content-type');

      if (contentType?.includes('application/json')) {
        data = await response.json();
      } else if (contentType?.includes('text/')) {
        data = (await response.text()) as T;
      } else {
        data = (await response.blob()) as T;
      }

      return {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        ok: response.ok,
      };
    } catch (error) {
      lastError = error as RequestError;

      // Don't retry on abort or certain errors
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || lastError.status === 401 || lastError.status === 403)
      ) {
        break;
      }

      // Don't retry streaming requests
      if (stream || onStream) {
        break;
      }

      // Retry if attempts remaining
      if (attempt < retries) {
        await sleep(retryDelay * Math.pow(2, attempt)); // Exponential backoff
        attempt++;
        continue;
      }

      break;
    }
  }

  if (timeoutId) clearTimeout(timeoutId);

  throw lastError || new Error('Request failed');
}

/**
 * Convenience methods for common HTTP verbs
 */
export const get = <T = unknown>(url: string, config?: Omit<RequestConfig, 'method'>) =>
  request<T>(url, { ...config, method: 'GET' });

export const post = <T = unknown>(url: string, body?: unknown, config?: Omit<RequestConfig, 'method' | 'body'>) =>
  request<T>(url, { ...config, method: 'POST', body });

export const put = <T = unknown>(url: string, body?: unknown, config?: Omit<RequestConfig, 'method' | 'body'>) =>
  request<T>(url, { ...config, method: 'PUT', body });

export const patch = <T = unknown>(url: string, body?: unknown, config?: Omit<RequestConfig, 'method' | 'body'>) =>
  request<T>(url, { ...config, method: 'PATCH', body });

export const del = <T = unknown>(url: string, config?: Omit<RequestConfig, 'method'>) =>
  request<T>(url, { ...config, method: 'DELETE' });

/**
 * Streaming-specific convenience methods
 */
export const streamGet = (url: string, config?: Omit<RequestConfig, 'method' | 'stream'>) =>
  request(url, { ...config, method: 'GET', stream: true }) as Promise<StreamResponse>;

export const streamPost = (url: string, body?: unknown, config?: Omit<RequestConfig, 'method' | 'body' | 'stream'>) =>
  request(url, { ...config, method: 'POST', body, stream: true }) as Promise<StreamResponse>;

/**
 * Helper to combine multiple abort signals
 */
function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  return controller.signal;
}

/**
 * Helper to sleep for a given duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

