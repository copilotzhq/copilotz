/** A fetch a test answers, keeping what it was asked: no network. */
export type Seen = {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
  signal?: AbortSignal;
};

/** A fetch that answers with `answer`, keeping what it was asked. */
export function fake(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const asked: Seen = {
      url: String(input),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      ...(typeof init.body === "string" ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    };
    seen.push(asked);
    return await answer(asked);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

export const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
