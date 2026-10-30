/**
 * Browser work: a batch of actions in whose's browser in its space (hidden,
 * or shown on the person's screen), and the browser's side of a web search
 * (when fetching it was turned away). Where comes from the scope; the
 * request is only actions, and the window.
 */
import type { BrowserInput, BrowserResult, Scope } from "../../shared/workloads.ts";
import type { Browsers } from "../browser/mod.ts";
import type { Request } from "../browser/types.ts";
import { checkScope, type Spaces } from "./spaces.ts";
import type { BrowserSearch } from "./search.ts";

export function createBrowserWork(browsers: Browsers, spaces: Spaces) {
  const where = async (value: Scope) => {
    const scope = checkScope(value);
    return { folder: scope.folder, workdir: await spaces.folder(scope), who: scope.who };
  };
  const search: BrowserSearch = async (input, signal) =>
    browsers.search(await where(input.scope), input.query, input.limit, signal);
  return {
    /** The batch, in whose's context. */
    async run(input: BrowserInput, signal?: AbortSignal): Promise<BrowserResult> {
      const { scope, ...request } = input;
      return await browsers.run(await where(scope), request as Request, signal);
    },
    /** A search through the browser, or none when there's no browser. */
    search: browsers.chromium ? search : undefined,
  };
}
