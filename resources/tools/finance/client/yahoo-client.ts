import { FinanceError } from './errors.ts';

export interface YahooCredentials {
  cookie: string;
  crumb: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}

export async function acquireCookieAndCrumb(options: RequestOptions = {}): Promise<YahooCredentials> {
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? 15000;
  const controller = new AbortController();
  
  if (signal) {
    signal.addEventListener('abort', () => controller.abort());
  }
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // 1. Get cookie from fc.yahoo.com
    const fcResponse = await fetch('https://fc.yahoo.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      redirect: 'manual',
      signal: controller.signal,
    });

    const setCookie = fcResponse.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';')[0];
    if (!cookie) {
      throw new FinanceError({
        code: 'upstream_unavailable',
        message: 'Failed to acquire cookie from fc.yahoo.com (no set-cookie header)',
      });
    }

    // 2. Get crumb from getcrumb
    const crumbResponse = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': cookie,
      },
      signal: controller.signal,
    });

    if (!crumbResponse.ok) {
      if (crumbResponse.status === 429) {
        throw new FinanceError({
          code: 'rate_limited',
          message: 'Yahoo rate limit hit during crumb acquisition',
        });
      }
      throw new FinanceError({
        code: 'upstream_unavailable',
        message: `Failed to acquire crumb from Yahoo: HTTP ${crumbResponse.status}`,
      });
    }

    const crumb = (await crumbResponse.text()).trim();
    if (!crumb) {
      throw new FinanceError({
        code: 'upstream_unavailable',
        message: 'Acquired empty crumb from Yahoo',
      });
    }

    return { cookie, crumb };
  } catch (err) {
    if (err instanceof FinanceError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new FinanceError({
        code: 'upstream_timeout',
        message: 'Timeout or cancellation during cookie/crumb acquisition',
        cause: err,
      });
    }
    throw new FinanceError({
      code: 'upstream_unavailable',
      message: `Network error during cookie/crumb acquisition: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function doYahooRequest<T>(
  url: string,
  cookie?: string,
  options: RequestOptions = {}
): Promise<T> {
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? 20000;
  const controller = new AbortController();

  if (signal) {
    signal.addEventListener('abort', () => controller.abort());
  }
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...(options.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (cookie) {
    headers['Cookie'] = cookie;
  }

  let attempts = 0;
  const maxAttempts = 3;
  let delay = 500;

  try {
    while (attempts < maxAttempts) {
      attempts++;
      try {
        const response = await fetch(url, {
          method: options.method || 'GET',
          body: options.body,
          headers,
          signal: controller.signal,
        });

        if (response.status === 404) {
          throw new FinanceError({
            code: 'not_found',
            message: `Resource not found at ${url}`,
          });
        }

        if (response.status === 429) {
          if (attempts < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay *= 2;
            continue;
          }
          throw new FinanceError({
            code: 'rate_limited',
            message: 'Yahoo rate limit hit during request execution',
          });
        }

        if (!response.ok) {
          if (response.status >= 500 && attempts < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay *= 2;
            continue;
          }
          throw new FinanceError({
            code: 'upstream_unavailable',
            message: `Yahoo upstream error: HTTP ${response.status}`,
          });
        }

        const text = await response.text();
        try {
          return JSON.parse(text) as T;
        } catch (err) {
          throw new FinanceError({
            code: 'parse_error',
            message: 'Failed to parse Yahoo JSON response',
            cause: err,
          });
        }
      } catch (err) {
        if (err instanceof FinanceError) throw err;
        if (err instanceof Error && err.name === 'AbortError') {
          throw new FinanceError({
            code: 'upstream_timeout',
            message: 'Yahoo request timed out or was cancelled',
            cause: err,
          });
        }
        if (attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2;
          continue;
        }
        throw new FinanceError({
          code: 'upstream_unavailable',
          message: `Network error during Yahoo request: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        });
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  throw new FinanceError({
    code: 'upstream_unavailable',
    message: 'Yahoo request failed after maximum retry attempts',
  });
}

export async function doAuthenticatedYahooRequest<T>(
  url: string | URL,
  options: RequestOptions = {}
): Promise<T> {
  const { cookie, crumb } = await acquireCookieAndCrumb(options);
  const finalUrl = new URL(String(url));
  finalUrl.searchParams.set('crumb', crumb);
  return await doYahooRequest<T>(finalUrl.toString(), cookie, options);
}
