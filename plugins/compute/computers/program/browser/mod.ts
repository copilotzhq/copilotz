/**
 * The browser engine (sandbox-lite's DevTools engine, on `node:` APIs): a
 * Chrome per space and who, each on a profile of its own that outlasts it,
 * hidden or shown on the person's screen, and batches of actions run one at
 * a time per who. Who a request is for comes from its scope, never from the
 * request. A who's Chrome unused for 30 minutes stops; used again, it starts
 * again, hidden unless asked, still signed in.
 */
import process from "node:process";
import { setInterval } from "node:timers";
import { perform } from "./actions.ts";
import { browserError, deadline, isBrowserError, message, race } from "./async.ts";
import { runBatch } from "./batch.ts";
import { cannotShow } from "./chrome.ts";
import { createLiveHub, type Duplex } from "./live.ts";
import { createSession, type Learned, type Session } from "./session.ts";
import type { Options, Request, Result, Window } from "./types.ts";

export type { Action, Options, Request, Result, Window, Windows } from "./types.ts";
export type { Duplex, Frame, ServerMessage, ViewerMessage } from "./live.ts";
export { cannotShow, findChrome } from "./chrome.ts";
export { profileName, profilePath } from "./profile.ts";
export { BROWSER_ACTIONS, browserInputSchema, browserOutputSchema } from "./schema.ts";

/** Whose browser: the space's folder, by name and as a real path, and who. */
export type Where = { folder: string; workdir: string; who: string };

const FIELDS = new Set(["actions", "timeoutMs", "stopOnError", "window"]);
const WINDOWS = new Set<unknown>(["hidden", "shown"]);

/** What a request that couldn't run answers. */
const refused = (code: string, error: string, window: Window): Result => ({
  success: false,
  stoppedEarly: true,
  window,
  results: [{ success: false, code, error }],
});

export function createBrowsers(options: Options) {
  const sessions = new Map<string, Session>();
  const hubs = new Map<Session, ReturnType<typeof createLiveHub>>();
  const learned: Learned = {};
  const idleMs = options.idleMs ?? 30 * 60_000;
  let closed = false;

  const keyOf = (where: Where) => `${where.folder}\u0000${where.who}`;

  function sessionOf(where: Where, create = true): Session {
    if (closed) throw browserError("closed", "The browser engine is closed");
    let session = sessions.get(keyOf(where));
    if (!session) {
      if (!create) throw browserError("session_missing", "This browser isn't open");
      session = createSession(where, options, learned);
      sessions.set(keyOf(where), session);
    }
    return session;
  }

  /**
   * Who's Chrome stops (its profile stays), and where it was is forgotten: the
   * next starts hidden, on a blank page. Who's browser itself stays, so work
   * already waiting on it starts that next one, never one nobody would stop.
   */
  async function end(session: Session) {
    await session.end();
    hubs.delete(session);
  }

  // Browsers unused for a while stop.
  const sweeper = setInterval(() => {
    const idle = (session: Session) =>
      session.running && Date.now() - session.lastUsed >= idleMs && !session.control.agent &&
      !session.control.human && !hubs.get(session)?.watching;
    for (const session of sessions.values()) {
      if (!idle(session)) continue;
      void session.queue.run(async () => {
        if (idle(session)) await end(session);
      }).catch(() => {});
    }
  }, Math.max(10, Math.min(60_000, idleMs / 2)));
  sweeper.unref();

  async function run(where: Where, request: Request, signal?: AbortSignal): Promise<Result> {
    const now = () => sessions.get(keyOf(where))?.window ?? "hidden";
    if (
      !Array.isArray(request?.actions) || !request.actions.length || request.actions.length > 10 ||
      new TextEncoder().encode(JSON.stringify(request)).length > 48 * 1024
    ) return refused("invalid", "A browser request has 1–10 actions, in at most 48 KiB", now());
    if (Object.keys(request).some((key) => !FIELDS.has(key))) {
      return refused("invalid", `A browser request has only ${[...FIELDS].join(", ")}`, now());
    }
    for (const ms of [request.timeoutMs, ...request.actions.map((action) => action.timeoutMs)]) {
      if (ms !== undefined && (!Number.isInteger(ms) || ms < 1 || ms > 300_000)) {
        return refused("invalid", "timeoutMs must be a whole number from 1 to 300000", now());
      }
    }
    if (request.window !== undefined && !WINDOWS.has(request.window)) {
      return refused("invalid", 'window is "hidden" or "shown"', now());
    }
    if (!options.chromium) {
      return refused(
        "no_browser",
        "This computer has no Chrome or Chromium: install one, or set COPILOTZ_CHROMIUM",
        now(),
      );
    }
    if (request.window === "shown") {
      const cannot = cannotShow(options.windows, options.env ?? process.env);
      if (cannot) return refused(cannot.code, cannot.message, now());
    }
    const limit = deadline(request.timeoutMs ?? 240_000, signal);
    let release: (() => void) | undefined;
    let working: Promise<Result> | undefined;
    let started = false;
    let session: Session | undefined;
    try {
      const s = session = sessionOf(where);
      if (
        request.window === undefined &&
        request.actions.every((action) => action.action === "control")
      ) {
        return {
          success: true,
          stoppedEarly: false,
          window: s.window,
          results: request.actions.map((_, actionIndex) => ({
            action: "control",
            actionIndex,
            success: true,
            ...s.control.state(),
          })),
        };
      }
      release = await s.control.acquireAgent(options.humanWaitMs ?? 5000, limit.signal);
      working = s.queue.run(async () => {
        if (closed) throw browserError("closed", "The browser engine is closed");
        limit.signal.throwIfAborted();
        started = true;
        s.lastUsed = Date.now();
        await s.open(limit.signal, request.window);
        const result = await runBatch(
          request,
          limit.signal,
          options.actionTimeoutMs ?? 30_000,
          async (action, actionSignal) => {
            const output = await perform(s, action, actionSignal);
            if (await s.followPopup(actionSignal)) {
              Object.assign(output, await s.page!.read({ action: "read" }, actionSignal));
            }
            if (action.snapshotAfter) Object.assign(output, await s.page!.snapshot(actionSignal));
            if (action.action === "close") await end(s);
            return output;
          },
          () => s.close(),
        );
        return {
          ...result,
          ...(s.page ? { currentUrl: s.page.url, title: s.page.title } : {}),
          window: s.window,
        };
      });
      return await race(working, limit.signal);
    } catch (error) {
      return refused(
        isBrowserError(error) ? error.code : signal?.aborted ? "aborted" : "browser_error",
        message(error),
        session?.window ?? now(),
      );
    } finally {
      // Control isn't handed on while cancelled work still drives the browser.
      if (started) await working?.catch(() => {});
      release?.();
      limit.dispose();
      if (session) session.lastUsed = Date.now();
    }
  }

  return {
    /** The Chrome it drives, or null. */
    chromium: options.chromium,
    run,
    /** A web search in the browser (search's fallback): its results, and whether it was turned away. */
    async search(where: Where, query: string, count: number, signal?: AbortSignal) {
      const result = await run(
        where,
        { actions: [{ action: "web_search", query, count }] },
        signal,
      );
      const found = result.results[0] ?? {};
      if (typeof found.error === "string") throw browserError(String(found.code), found.error);
      return {
        results: (found.results ?? []) as { title: string; url: string; snippet: string }[],
        blocked: found.blocked === true,
      };
    },
    /** Serves a live viewer of who's browser (not wired to a workload yet). */
    async live(where: Where, duplex: Duplex, signal?: AbortSignal) {
      const startup = deadline(options.launchTimeoutMs ?? 20_000, signal);
      let hub: ReturnType<typeof createLiveHub>;
      try {
        const session = sessionOf(where, false);
        hub = await session.queue.run(async () => {
          startup.signal.throwIfAborted();
          await session.open(startup.signal);
          let found = hubs.get(session);
          if (!found || found.closed) {
            found = createLiveHub(session, (fn) => session.queue.run(fn));
            hubs.set(session, found);
          }
          return found;
        });
      } finally {
        startup.dispose();
      }
      await hub.attach(duplex, signal);
    },
    /** Every browser stops (keeping what its profile keeps). */
    async close() {
      closed = true;
      clearInterval(sweeper);
      await Promise.all([...sessions.values()].map((s) => s.close().catch(() => {})));
      sessions.clear();
      hubs.clear();
    },
  };
}

export type Browsers = ReturnType<typeof createBrowsers>;
