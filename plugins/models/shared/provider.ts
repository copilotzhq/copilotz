/**
 * What every provider connection shares (LLM, embeddings, transcription):
 * where requests go and how they authenticate.
 *
 * - `baseURL` switches provider: any endpoint speaking the same API.
 * - `apiKey` fills the provider's usual auth header.
 * - `headers` add to, or replace, any header (a gateway's auth, Azure's
 *   `api-key`, a proxy's routing header…). They are applied last. A function
 *   computes them for each request: an OAuth token that refreshes.
 */
export type Endpoint = {
  baseURL?: string;
  apiKey?: string;
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
};

/**
 * What one provider call used, for cost tracking. `input` counts every input
 * token, cached ones included; `cached` of them were read from the provider's
 * prompt cache (billed at a discount) and `cacheWrite` written to it (Anthropic
 * bills those at a premium). `output` counts every output token, `reasoning`
 * ones included. `seconds` is audio billed by length.
 */
export type Usage = {
  input: number;
  output: number;
  cached?: number;
  cacheWrite?: number;
  reasoning?: number;
  seconds?: number;
};

/** Usage with only the counts a provider reported. */
export const usageOf = (usage: Usage): Usage =>
  Object.fromEntries(
    Object.entries(usage).filter(([key, value]) =>
      key === "input" || key === "output" || (typeof value === "number" && value > 0)
    ),
  ) as Usage;

/** A provider's own defaults: its URL and how an API key becomes headers. */
export type Defaults = {
  name: string;
  baseURL: string;
  auth?: (apiKey: string) => Record<string, string>;
  headers?: Record<string, string>;
};

const provider = (name: string, status: number, text: string) =>
  Object.assign(new Error(`${name} ${status}: ${text.slice(0, 500)}`), {
    code: "provider_error",
    status,
  });

/** POSTs to the provider; JSON bodies are encoded, other bodies are sent as they are. */
export async function post(
  endpoint: Endpoint,
  defaults: Defaults,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const url = `${(endpoint.baseURL ?? defaults.baseURL).replace(/\/+$/, "")}${path}`;
  const headers = new Headers(defaults.headers);
  if (endpoint.apiKey && defaults.auth) {
    for (const [name, value] of Object.entries(defaults.auth(endpoint.apiKey))) {
      headers.set(name, value);
    }
  }
  const raw = body instanceof FormData || body instanceof Uint8Array || typeof body === "string";
  if (!raw) headers.set("content-type", "application/json");
  const extra = typeof endpoint.headers === "function"
    ? await endpoint.headers()
    : endpoint.headers;
  for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: raw ? body as BodyInit : JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw provider(defaults.name, response.status, await response.text());
  return response;
}

/** Server-sent events: each event's name (if any) and its data. */
export async function* sse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event?: string; data: string }> {
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  const flush = function* () {
    if (data.length) yield { ...(event ? { event } : {}), data: data.join("\n") };
    event = undefined;
    data = [];
  };
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (line === "") yield* flush();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("event:")) event = line.slice(6).trim();
    }
  }
  yield* flush();
}
