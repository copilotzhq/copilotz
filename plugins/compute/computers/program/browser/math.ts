/**
 * Math as its source: while a page loads for an agent, MathJax scripts are
 * refused, so formulas read as the TeX they're written in rather than as
 * glyphs (unless the agent asks for `renderMath`).
 */
import type { DevTools } from "./cdp.ts";

const MATHJAX = /(?:^|[./@_-])mathjax(?:[./@_-]|$)/iu;

type Paused = { requestId: string; resourceType: string; request: { url: string } };

/** Refuses MathJax scripts on this page until the answer is called. */
export async function holdMath(cdp: DevTools, signal: AbortSignal): Promise<() => Promise<void>> {
  const off = cdp.on<Paused>("Fetch.requestPaused", (event) => {
    let target: URL | undefined;
    try {
      target = new URL(event.request.url);
    } catch {
      target = undefined;
    }
    const math = event.resourceType === "Script" && target &&
      MATHJAX.test(target.hostname + target.pathname);
    void (math
      ? cdp.send("Fetch.failRequest", {
        requestId: event.requestId,
        errorReason: "BlockedByClient",
      })
      : cdp.send("Fetch.continueRequest", { requestId: event.requestId })).catch(() => {});
  });
  try {
    await cdp.send("Fetch.enable", {
      patterns: ["*mathjax*", "*MathJax*"].map((urlPattern) => ({
        urlPattern,
        resourceType: "Script",
        requestStage: "Request",
      })),
    }, signal);
  } catch (error) {
    off();
    throw error;
  }
  return async () => {
    off();
    await cdp.send("Fetch.disable").catch(() => {});
  };
}
