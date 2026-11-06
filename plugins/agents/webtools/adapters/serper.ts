/** Serper.dev's Google search API as the `search` port: one POST, its key in `X-API-KEY`. */
import { failure } from "../../../../runtime/mod.ts";
import type { SearchAdapter } from "../contract.ts";

type Organic = { title?: string; link?: string; snippet?: string };

export const serper: SearchAdapter = {
  subject: "serper",
  async search({ connection, query, count, language, country, fetch, signal }) {
    if (!connection.apiKey) throw failure("key_missing", "There's no key for the search engine");
    const response = await fetch(connection.endpoint ?? "https://google.serper.dev/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": connection.apiKey },
      body: JSON.stringify({
        q: query,
        num: count,
        ...(language ? { hl: language } : {}),
        ...(country ? { gl: country } : {}),
        ...connection.options,
      }),
      signal,
    });
    if (!response.ok) {
      throw failure("unreachable", `The search engine answered HTTP ${response.status}`);
    }
    const body = await response.json() as { organic?: Organic[] };
    return (body.organic ?? []).filter((r) => r.link).slice(0, count).map((r) => ({
      title: r.title ?? r.link!,
      url: r.link!,
      snippet: r.snippet ?? "",
    }));
  },
};
