/** An offline search engine for tests and demos: `count` results made from the query. */
import type { SearchAdapter } from "../contract.ts";

export const fake: SearchAdapter = {
  subject: "fake",
  search: ({ query, count }) =>
    Promise.resolve(Array.from({ length: Math.min(count, 3) }, (_, i) => ({
      title: `Result ${i + 1} for ${query}`,
      url: `https://example.com/${encodeURIComponent(query)}/${i + 1}`,
      snippet: `About ${query}, number ${i + 1}.`,
    }))),
};
