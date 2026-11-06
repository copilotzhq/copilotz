/**
 * Web tools: agents that search the web and read a page, without a computer.
 * `webTools` is an ordinary plugin of two tools, which agents get by naming
 * them in their `tools`:
 *
 * - **`web_search`** `{ query, count?, language?, country? }` → `{ results:
 *   [{ title, url, snippet }] }`. Search is the `search` adapter port
 *   (`webTools.search.adapter`): `serper` (Serper.dev, the default; its key
 *   is `webTools.search.apiKey`, called through `ctx.fetch`) and `fake`
 *   (offline). Another engine (Brave, Google) is one more adapter under
 *   `adapters.search`.
 * - **`read_page`** `{ url, start? }` → the page's final URL (after
 *   redirects), title, main text (without scripts, styles or navigation) and
 *   links, up to `pageChars` characters; a longer page says the `start` to
 *   read on from. The text is marked as data from the web, never
 *   instructions.
 *
 * **Safe by design.** `read_page` fetches only http(s) URLs, through
 * `ctx.fetch`, with no cookies and an honest user agent. It resolves the
 * host and refuses loopback, private, link-local (the metadata address),
 * carrier-grade, multicast and reserved addresses, in IPv4 and IPv6, on
 * every redirect (`redirects`, 4 at most); ports other than 80 and 443
 * unless the app lists them (`ports`); URLs with a password. A page may take
 * `timeout` (15 s) and `maxBytes` (2 MB), and be HTML or text (JSON, XML,
 * Markdown, CSV); a PDF or any other type is refused. One turn reads at most
 * `readsPerTurn` (8) pages. Resolving and fetching are two steps, so a host
 * that changes its answer between them (DNS rebinding) is not caught here:
 * an app that must be sure puts the runtime behind an egress filter.
 *
 * **Metered.** A search is a `search` use of the ledger (an `agents`
 * category meter), subject the adapter's (`serper`), one `queries`; the
 * `modelUse` listeners and the `spending` check are asked before it, as
 * before a model call, and a refusal is final and stops the turn with its reason, as for a model.
 * Price it from resources: `cost: { serper: { queries: 0.001, per: 1 } }`.
 * Reading a page is free, and limited.
 *
 * ```ts
 * plugins: [models, chat, usage, webTools, definePlugin({
 *   name: "app",
 *   resources: {
 *     webTools: { search: { apiKey: Deno.env.get("SERPER_KEY") } },
 *     cost: { serper: { queries: 0.001, per: 1 } },
 *     agents: { scout: { instructions, model, tools: ["web_search", "read_page"] } },
 *   },
 * })]
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { fake } from "./adapters/fake.ts";
import { serper } from "./adapters/serper.ts";
import { read_page, web_search } from "./resources/tools.ts";
import { settingsOf } from "./shared/settings.ts";

export * from "./contract.ts";

export const webTools: Plugin = definePlugin({
  name: "webTools",
  requires: ["chat"],
  resources: { tools: { web_search, read_page } },
  adapters: { search: { serper, fake } },
  check(merged) {
    const { adapter } = settingsOf(merged).search;
    if (!merged.adapters.search?.[adapter]) {
      throw new Error(
        `webTools: no search adapter "${adapter}" (have: ${
          Object.keys(merged.adapters.search ?? {}).join(", ")
        })`,
      );
    }
  },
});

export default webTools;
