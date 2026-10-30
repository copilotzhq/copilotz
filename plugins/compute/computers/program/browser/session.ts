/**
 * One who's browser in a space: a Chrome of its own, on its own profile (see
 * profile.ts), hidden or shown, with the tab it's on, the popups that tab
 * opens, and who controls it. Its Chrome starts when it's first used, and
 * again after it stops (idle, retired, or ended on its own), on the same
 * profile, so cookies, sign-ins and site storage stay. Asked for the other
 * window, it starts again in that one, back on the page it was on.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserError, createQueue, deadline, delay, isBrowserError, type Queue } from "./async.ts";
import type { Client } from "./cdp.ts";
import { type Chrome, launch, type Window } from "./chrome.ts";
import { type Control, createControl } from "./control.ts";
import { createPage, type Page } from "./page.ts";
import { keepSessionCookies, profilePath, restoreSessionCookies } from "./profile.ts";
import { directory } from "./storage.ts";
import type { Options } from "./types.ts";

export type Target = {
  targetId: string;
  type: string;
  title: string;
  url: string;
  openerId?: string;
  browserContextId?: string;
};

/** What a hidden Chrome presents as its user agent: learned from the first, and kept. */
export type Learned = { agent?: { product: string; userAgent: string } };

export type Session = {
  readonly who: string;
  /** The space's folder (a real path), where uploads come from and downloads go. */
  readonly workdir: string;
  /** Its Chrome's user data directory. */
  readonly profile: string;
  readonly options: Options;
  readonly control: Control;
  readonly pages: Map<string, Page>;
  /** Live viewers, told before it closes. */
  readonly closing: Set<() => Promise<void>>;
  readonly pageChanges: Set<() => void>;
  /** Its batches, one at a time. */
  readonly queue: Queue;
  page?: Page;
  /** Its Chrome's window: the running one's, or the one it starts in next. */
  window: Window;
  /** A private folder for files on their way in or out. */
  staging: string;
  lastUsed: number;
  /** Its Chrome's DevTools client (once open). */
  client(): Client;
  /** Its Chrome, running (in `window`, when given) with a tab selected. */
  open(signal: AbortSignal, window?: Window): Promise<void>;
  targets(signal: AbortSignal): Promise<Target[]>;
  select(id: string, signal: AbortSignal): Promise<void>;
  newPage(url: string, signal: AbortSignal): Promise<Page>;
  /** Moves to a popup its tab just opened, if there is one. */
  followPopup(signal: AbortSignal): Promise<boolean>;
  /** Whether its Chrome is running. */
  readonly running: boolean;
  /** Stops its Chrome (keeping its session cookies); opened again, it's back on its page. */
  close(): Promise<void>;
  /** Stops its Chrome, and forgets where it was: opened again, it's hidden, on a blank page. */
  end(): Promise<void>;
};

/** Pages only it can reopen: the web's. */
const reopenable = (url: string | undefined) => !!url && /^https?:/i.test(url);

export function createSession(
  where: { folder: string; workdir: string; who: string },
  options: Options,
  learned: Learned,
): Session {
  const { folder, workdir, who } = where;
  let chrome: Chrome | undefined;
  /** A Chrome on its way up: stopping waits for it, so none outlives its stop. */
  let starting: Promise<unknown> | undefined;
  let popup: string | undefined;
  let savedUrl: string | undefined;
  let closingTask: Promise<void> | undefined;

  const pageChanged = () => {
    for (const fn of session.pageChanges) fn();
  };

  /** Its tabs are gone (with their Chrome): the page it was on is kept, to go back to. */
  const forgetPages = () => {
    if (session.page) savedUrl = reopenable(session.page.url) ? session.page.url : undefined;
    for (const page of session.pages.values()) page.dispose();
    session.pages.clear();
    session.page = undefined;
    popup = undefined;
  };

  /**
   * A Chrome in `session.window`. Hidden, it presents Chrome's own user agent
   * without "Headless": learned from the first one (or again, when Chrome was
   * updated since), which then starts again presenting it.
   */
  const launchChrome = async (signal: AbortSignal) => {
    const shown = session.window === "shown";
    for (let launches = 1;; launches++) {
      const agent = shown ? undefined : learned.agent;
      const started = await launch({
        chromium: options.chromium!,
        profile: session.profile,
        window: session.window,
        title: `Copilotz – ${who} (${folder})`,
        userAgent: agent?.userAgent,
        width: options.width,
        height: options.height,
        env: options.env,
        launchTimeoutMs: options.launchTimeoutMs,
        closeTimeoutMs: options.closeTimeoutMs,
        onProcess: options.onProcess,
      }, signal);
      const stale = agent
        ? agent.product !== started.product
        : started.userAgent.includes("Headless");
      if (shown || !stale || launches >= 3) return started;
      learned.agent = agent ? undefined : {
        product: started.product,
        userAgent: started.userAgent.replaceAll("Headless", ""),
      };
      await started.close();
    }
  };

  /** Starts its Chrome; its targets' events come here. */
  const start = async (signal: AbortSignal) => {
    if (!options.chromium) throw new Error("No Chrome or Chromium on this computer");
    await directory(session.profile);
    const started = await launchChrome(signal);
    const client = started.client;
    // Shown, what its person does there (tabs, pages) counts as use.
    const touched = () => {
      if (started.window === "shown") session.lastUsed = Date.now();
    };
    client.on<{ targetId: string }>("Target.targetDestroyed", ({ targetId }) => {
      touched();
      if (popup === targetId) popup = undefined;
      const page = session.pages.get(targetId);
      if (!page) return;
      page.dispose();
      session.pages.delete(targetId);
      if (session.page === page) {
        // Its tab gone (its person closed the window, say), a new Chrome can go back there.
        savedUrl = reopenable(page.url) ? page.url : undefined;
        session.page = session.pages.values().next().value;
        pageChanged();
      }
    });
    client.on<{ targetInfo: Target }>("Target.targetCreated", ({ targetInfo: target }) => {
      touched();
      if (target.type === "page" && target.openerId && target.openerId === session.page?.id) {
        popup = target.targetId;
      }
    });
    client.on<{ targetInfo: Target }>("Target.targetInfoChanged", ({ targetInfo: target }) => {
      touched();
      const page = session.pages.get(target.targetId);
      if (!page) return;
      page.title = target.title;
      page.url = target.url;
    });
    try {
      await client.send("Target.setDiscoverTargets", { discover: true }, signal);
      // Downloads go only where the download action puts them.
      await client.send("Browser.setDownloadBehavior", { behavior: "deny" }, signal);
      await restoreSessionCookies(client, session.profile, signal);
      session.staging ||= await mkdtemp(join(tmpdir(), "copilotz-browser-"));
    } catch (error) {
      await started.close();
      throw error;
    }
    chrome = started;
  };

  /** Stops its Chrome, keeping its session cookies first. */
  const stop = async () => {
    const running = chrome;
    chrome = undefined;
    if (!running) return;
    if (!running.client.closed) {
      const limit = deadline(3000);
      await keepSessionCookies(running.client, session.profile, limit.signal).catch(() => {});
      limit.dispose();
    }
    await running.close();
  };

  const closeNow = async () => {
    await starting;
    // Viewers go before the tabs do.
    await Promise.all([...session.closing].map((close) => close()));
    forgetPages();
    await stop();
    if (session.staging) {
      await rm(session.staging, { recursive: true, force: true });
      session.staging = "";
    }
  };

  const session: Session = {
    who,
    workdir,
    profile: profilePath(options.root, folder, who),
    options,
    control: createControl(),
    pages: new Map(),
    closing: new Set(),
    pageChanges: new Set(),
    queue: createQueue(),
    window: "hidden",
    staging: "",
    lastUsed: Date.now(),
    client() {
      if (!chrome) throw browserError("disconnected", "The browser isn't running");
      return chrome.client;
    },
    async open(signal, window) {
      signal.throwIfAborted();
      await closingTask;
      if (chrome?.client.closed) {
        // It ended on its own (it crashed, or its person quit it): reaped, and hidden next unless asked.
        forgetPages();
        const ended = chrome;
        chrome = undefined;
        await ended.close().catch(() => {});
        session.window = "hidden";
      }
      if (window && window !== session.window) {
        // The other window: this Chrome stops, and one in that window starts where it was.
        if (chrome) await session.close();
        session.window = window;
      }
      if (!chrome) {
        const started = start(signal);
        starting = started.catch(() => {});
        try {
          await started;
        } catch (error) {
          // What couldn't start isn't there: the next starts hidden, unless asked.
          session.window = "hidden";
          throw error;
        } finally {
          starting = undefined;
        }
      }
      if (session.page) return;
      const targets = await session.targets(signal);
      if (targets.length) await session.select(targets[0].targetId, signal);
      else await session.newPage("about:blank", signal);
      // Back where it was, if it can be.
      if (savedUrl && session.page!.url !== savedUrl) {
        await session.page!.navigate(savedUrl, signal).catch((error) => {
          if (signal.aborted) throw error;
        });
      }
    },
    async targets(signal) {
      const { targetInfos } = await session.client().send<{ targetInfos: Target[] }>(
        "Target.getTargets",
        {},
        signal,
      );
      return targetInfos.filter((target) => target.type === "page");
    },
    async select(id, signal) {
      if (!(await session.targets(signal)).some((target) => target.targetId === id)) {
        throw browserError("devtools_error", `Unknown page target ${id}`);
      }
      const client = session.client();
      let page = session.pages.get(id);
      if (!page) {
        const { sessionId } = await client.send<{ sessionId: string }>(
          "Target.attachToTarget",
          { targetId: id, flatten: true },
          signal,
        );
        page = createPage(
          id,
          client.session(sessionId),
          options.width ?? 1280,
          options.height ?? 720,
        );
        session.pages.set(id, page);
        await page.init(signal, options.ignoreHTTPSErrors ?? true);
      }
      await client.send("Target.activateTarget", { targetId: id }, signal);
      session.page = page;
      pageChanged();
    },
    async newPage(url, signal) {
      const before = new Set((await session.targets(signal)).map((target) => target.targetId));
      const { targetId } = await session.client().send<{ targetId: string }>(
        "Target.createTarget",
        { url: "about:blank" },
        signal,
      );
      // Chrome can replace a new tab's target while it starts: select it, or what replaced it.
      for (let attempt = 0;; attempt++) {
        const pages = await session.targets(signal);
        const id = pages.some((target) => target.targetId === targetId)
          ? targetId
          : pages.find((target) => !before.has(target.targetId))?.targetId;
        try {
          if (!id) throw browserError("devtools_error", "New tab not ready");
          await session.select(id, signal);
          break;
        } catch (error) {
          if (attempt >= 40 || !isBrowserError(error)) throw error;
          await delay(50, signal);
        }
      }
      // A tab opened here can be reported as the current one's popup: it isn't one.
      if (popup && !before.has(popup)) popup = undefined;
      if (url !== "about:blank") await session.page!.navigate(url, signal);
      return session.page!;
    },
    async followPopup(signal) {
      const target = popup;
      popup = undefined;
      if (!target || target === session.page?.id) return false;
      // A popup can close before it's followed: then there's nothing to follow.
      if (!(await session.targets(signal)).some((t) => t.targetId === target)) return false;
      await session.select(target, signal);
      return true;
    },
    get running() {
      return !!chrome;
    },
    close() {
      return closingTask ??= closeNow().finally(() => {
        closingTask = undefined;
      });
    },
    async end() {
      await session.close();
      savedUrl = undefined;
      session.window = "hidden";
    },
  };
  return session;
}
