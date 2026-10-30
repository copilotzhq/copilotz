/**
 * One browser action, bounded by its signal. The engine owns admission and
 * the batch's deadline; an action that only acts (a click, a key) answers
 * with the page as it reads after.
 */
import { rm } from "node:fs/promises";
import { delay, race } from "./async.ts";
import { finite, keyPress, type Page } from "./page.ts";
import type { Session } from "./session.ts";
import { commitDownload, stageUpload, workspacePath } from "./storage.ts";
import type { Action } from "./types.ts";

/** Where `web_search` goes unless the engine is told otherwise. */
export const SEARCH_URL = "https://html.duckduckgo.com/html/";

/** Clicks what starts a download, and moves the file to `action.path` in the space's folder. */
async function download(session: Session, page: Page, action: Action, signal: AbortSignal) {
  if (!action.path) throw new Error("download.path is required");
  const root = session.workdir;
  await workspacePath(root, action.path, true);
  const client = session.client();
  let guid = "";
  let suggestedFilename = "";
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void completion.catch(() => {});
  const offBegin = client.on<{ guid: string; suggestedFilename: string; frameId: string }>(
    "Browser.downloadWillBegin",
    (e) => {
      if (e.frameId === page.frameId && !guid) {
        guid = e.guid;
        suggestedFilename = e.suggestedFilename;
      }
    },
  );
  const offProgress = client.on<{ guid: string; state: string }>(
    "Browser.downloadProgress",
    (e) => {
      if (e.guid !== guid) return;
      if (e.state === "completed") resolve();
      else if (e.state === "canceled") reject(new Error("Download canceled"));
    },
  );
  try {
    await client.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: session.staging,
      eventsEnabled: true,
    }, signal);
    await page.click(action, signal);
    await race(completion, signal);
    await commitDownload(root, action.path, `${session.staging}/${guid}`);
    await rm(`${session.staging}/${guid}`, { force: true });
    return { path: action.path, suggestedFilename };
  } finally {
    offBegin();
    offProgress();
    if (signal.aborted && guid) {
      await client.send("Browser.cancelDownload", { guid }).catch(() => {});
    }
    await client.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
  }
}

/** Searches DuckDuckGo's HTML page in a tab of its own, and reads its results. */
async function search(session: Session, action: Action, signal: AbortSignal) {
  const query = action.query?.trim();
  if (!query) throw new Error("Search query is required");
  const url = new URL(session.options.searchUrl ?? SEARCH_URL);
  url.searchParams.set("q", query);
  for (
    const [key, value] of Object.entries({
      kl: action.region,
      kad: action.language,
      kp: action.safeSearch === "strict" ? "1" : action.safeSearch === "off" ? "-1" : undefined,
      df: action.timeRange
        ? { day: "d", week: "w", month: "m", year: "y" }[action.timeRange]
        : undefined,
    })
  ) if (value) url.searchParams.set(key, value);
  const original = session.page!;
  let page: Page | undefined;
  try {
    page = await session.newPage(url.href, signal);
    const count = Math.max(1, Math.min(action.count ?? 5, 25));
    const found = await page.evaluate<{
      results: { title: string; url: string; snippet: string }[];
      blocked: boolean;
    }>(
      `(() => { const clean = s => (s ?? '').replace(/\\s+/g,' ').trim(); const real = a => { try { const u = new URL(a.href); return u.searchParams.get('uddg') ?? (/(^|\\.)duckduckgo\\.com$/.test(u.hostname) && u.pathname.startsWith('/y.js') ? null : a.href); } catch { return null; } }; const results = Array.from(document.querySelectorAll('a.result__a')).map(a => ({title:clean(a.textContent),url:real(a),snippet:clean(a.closest('.result')?.querySelector('.result__snippet')?.textContent)})).filter(r => r.url).slice(0,${count}); return {results,blocked:!results.length && /anomaly-modal|g-recaptcha|are you a human|challenge-form|bots use DuckDuckGo/i.test(document.documentElement.innerHTML)}; })()`,
      signal,
    );
    return {
      success: !found.blocked,
      provider: "duckduckgo-html",
      query,
      ...found,
      count: found.results.length,
    };
  } finally {
    if (page) {
      await session.client().send("Target.closeTarget", { targetId: page.id }).catch(() => {});
    }
    if (session.pages.has(original.id)) await session.select(original.id, signal).catch(() => {});
  }
}

/** Does one action on the session's current tab. */
export async function perform(
  session: Session,
  action: Action,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (action.intercept) throw new Error("Browser request interception code is disabled");
  const page = session.page!;
  const cdp = page.cdp;
  switch (action.action) {
    case "navigate":
      await page.navigate(action.url!, signal, action.waitUntil, action.renderMath);
      return await page.summary(signal);
    case "click":
      await page.click(action, signal);
      break;
    case "type":
    case "fill":
      await page.fill(action, signal);
      break;
    case "read":
      return await page.read(action, signal);
    case "evaluate":
      return { result: await page.evaluate(action.expression!, signal) };
    case "screenshot": {
      let clip: Record<string, number> | undefined;
      if (action.selector || action.ref) {
        const object = await page.object(action, signal);
        try {
          await page.box(object, signal, false);
          clip = await page.call(
            object,
            "function() { const r=this.getBoundingClientRect(); return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1}; }",
            signal,
          );
        } finally {
          await page.release(object);
        }
      } else if (action.fullPage ?? true) {
        const { cssContentSize } = await cdp.send<
          { cssContentSize: { x: number; y: number; width: number; height: number } }
        >("Page.getLayoutMetrics", {}, signal);
        clip = { ...cssContentSize, scale: 1 };
      }
      const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        ...(clip ? { clip } : {}),
      }, signal);
      return { mime: "image/png", dataUrl: `data:image/png;base64,${data}` };
    }
    case "wait": {
      if (!action.until) {
        await delay(action.timeoutMs ?? session.options.actionTimeoutMs ?? 30_000, signal);
      } else if (action.until === "selector") {
        const object = await page.object(action, signal);
        try {
          await page.box(object, signal, false);
        } finally {
          await page.release(object);
        }
      } else await page.wait(action.until, signal);
      return { waitedFor: { ...action, action: undefined } };
    }
    case "mouseMove": {
      const steps = Math.max(1, Math.min(action.steps ?? 1, 100));
      for (let i = 1; i <= steps; i++) {
        await page.mouse(
          { ...action, x: finite(action.x, "x") * i / steps, y: finite(action.y, "y") * i / steps },
          signal,
          true,
        );
      }
      return { x: action.x, y: action.y, ...(action.steps ? { steps: action.steps } : {}) };
    }
    case "mouseClick":
      await page.mouse(action, signal);
      break;
    case "scroll":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: action.x ?? page.width / 2,
        y: action.y ?? page.height / 2,
        deltaX: finite(action.deltaX ?? 0, "deltaX"),
        deltaY: finite(action.deltaY ?? 0, "deltaY"),
      }, signal);
      break;
    case "keyPress":
      await keyPress(cdp, action.key!, signal, action.delayMs);
      break;
    case "download":
      return await download(session, page, action, signal);
    case "upload": {
      if (!action.path) throw new Error("upload.path is required");
      const file = await stageUpload(session.workdir, action.path, session.staging);
      const objectId = await page.object(action, signal);
      try {
        await cdp.send("DOM.setFileInputFiles", { files: [file], objectId }, signal);
      } finally {
        await page.release(objectId);
      }
      return { path: action.path };
    }
    case "web_search":
      return await search(session, action, signal);
    case "back":
    case "forward":
      await page.history(action.action, signal);
      break;
    case "reload":
      await cdp.send("Page.reload", {}, signal);
      await page.wait("domcontentloaded", signal);
      break;
    case "dialog":
      await cdp.send("Page.handleJavaScriptDialog", {
        accept: action.accept === true,
        promptText: action.text ?? "",
      }, signal);
      return { handled: true };
    case "tabs": {
      if (action.operation === "new") {
        await session.newPage(action.url ?? "about:blank", signal);
      } else if (action.operation === "select") {
        await session.select(action.tabId!, signal);
      } else if (action.operation === "close") {
        const id = action.tabId ?? page.id;
        if (!(await session.targets(signal)).some((t) => t.targetId === id)) {
          throw new Error("Unknown tab");
        }
        await session.client().send("Target.closeTarget", { targetId: id }, signal);
        // A closing tab is still listed for a moment: select another, not it.
        const remaining = (await session.targets(signal)).filter((t) => t.targetId !== id);
        if (remaining.length) await session.select(remaining[0].targetId, signal);
        else await session.newPage("about:blank", signal);
      }
      return {
        tabs: (await session.targets(signal)).map((target) => ({
          id: target.targetId,
          url: target.url,
          title: target.title,
          active: target.targetId === session.page?.id,
        })),
      };
    }
    case "control":
      return session.control.state();
    case "snapshot":
      return { ...await page.summary(signal), ...await page.snapshot(signal) };
    case "close":
      return { closed: true };
    default:
      throw new Error(`Unsupported browser action ${(action as Action).action}`);
  }
  return await page.read({ action: "read" }, signal);
}
