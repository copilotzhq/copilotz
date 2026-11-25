/**
 * A fetch handler listening on Node, through Oxian's Node adapter:
 * `listen(runtime.fetch)`. Node hands a socket over as an upgrade, not a
 * request; the adapter turns it into one, and completes the upgrade the
 * handler accepts: a runtime's own socket (`/oxian`, its own or another
 * runtime's a route forwarded the request to) straight to its Hypervisor,
 * and a route's (a voice call's relay) with Oxian's route upgrade
 * (`upgradeWebSocket`). Each request it hands
 * on says where it came from (the socket's peer: `clientAddress`), which
 * what's this machine's alone goes by (dev sign-in). Bun and Deno run it
 * too, through their Node compatibility.
 *
 * Serving a runtime's own handler (`runtime.fetch`), it also stops when that
 * runtime loses its store to another owner (`runtime.lost`): it stops
 * listening (its sockets close, and clients reconnect, to whoever serves
 * then) and the process exits with code 1, so the platform starts a new one.
 */
import process from "node:process";
import type { Hypervisor } from "@oxian/oxian-js";
import { serve as oxian } from "@oxian/oxian-js/adapters/node";
import { lostOf, upgradeOf } from "../../../runtime/fetch.ts";

/** Where to listen. */
export type ListenOptions = {
  /** `127.0.0.1` by default (this machine only); `0.0.0.0` for everyone's. */
  hostname?: string;
  /** The port; a free one by default (the listener's `url` says which). */
  port?: number;
  /** Stops listening when it aborts. */
  signal?: AbortSignal;
  /**
   * Said once it has stopped by itself, with the code the process exits
   * with: the runtime it serves (`runtime.fetch` itself) lost its store, 1.
   * By default the process exits with it (`process.exit`); an app that has
   * more to close first says so here, and exits itself.
   */
  stopped?: (code: number) => void;
};

/** What a process does once its server stopped by itself, unless the app says: it exits. */
const exit = (code: number) => process.exit(code);

/** A server listening: where, when it's done, and how to stop it (runtimes stay the app's). */
export type Listener = {
  hostname: string;
  port: number;
  url: URL;
  finished: Promise<void>;
  /** Stops listening; its sockets close. */
  shutdown(): Promise<void>;
};

/**
 * Serves a fetch handler (`runtime.fetch`): every request, sockets' upgrades
 * included. A runtime's own handler, lost, stops it and the process (above).
 */
export async function listen(
  fetch: (request: Request) => Response | Promise<Response>,
  options: ListenOptions = {},
): Promise<Listener> {
  const { hostname = "127.0.0.1", port = 0, signal, stopped = exit } = options;
  // Oxian's adapter asks what it serves only to prepare requests, after asking once if it's open.
  // A runtime's own socket goes to its Hypervisor's decision directly (`upgradeOf`); any other
  // answer, a route's socket included, as it is.
  const front = {
    prepare: async (request: Request) => {
      const response = await fetch(request);
      return upgradeOf(response) ?? { kind: "response", response };
    },
    snapshot: () => ({ acceptingConnections: true }),
  };
  const server = await oxian({
    hypervisor: front as unknown as Hypervisor,
    hostname,
    port,
    signal,
  });
  // Stopped already (the app's shutdown, its signal), it's the app's to say how the process ends.
  let over = false;
  void server.finished.then(() => over = true, () => over = true);
  void lostOf(fetch)?.then(async () => {
    if (over) return;
    await server.shutdown().catch(() => {});
    stopped(1);
  });
  return server;
}

/** What `serve` serves: a runtime, or anything that answers requests and closes like one. */
export type App = {
  fetch(request: Request): Response | Promise<Response>;
  close(options?: { drain?: number }): Promise<void>;
  /** Resolves if it stops serving by itself: a runtime that lost its store (`runtime.lost`). */
  lost?: Promise<unknown>;
};

/** What `serve` gives the lease it holds (`lease` from `copilotz/stores/postgres` takes it all). */
export type Holding = {
  /** Aborts when it stops while still waiting for the lease. */
  signal: AbortSignal;
  /** Another process holds it, and this one waits. */
  waiting(): void;
  /** A newer process waits for it: this one hands over. */
  asked(): void;
  /** It was lost: this one stops. */
  lost(why: string): void;
};

export type ServeOptions = ListenOptions & {
  /**
   * Takes the store's lease before the app opens, so one process at a time
   * writes it (`(on) => lease(pool, { revision, ...on })`): this process waits
   * for the one holding it, and hands over to the next.
   */
  hold?: (holding: Holding) => Promise<{ release(): Promise<void> }>;
  /** What a request gets until the app is open: a 503 to retry in 2 s (a page that reloads itself) by default. */
  starting?: (request: Request) => Response | Promise<Response>;
  /** How long running work gets to finish when it stops, in ms: 8 000 by default. */
  drain?: number;
  /**
   * Said once it has stopped by itself (it handed over: 0; it lost the lease,
   * or the app its store: 1) or by its `signal` (0). By default the process
   * exits with it (`process.exit`); an app that has more to close first (its
   * pool) says so here, and exits itself.
   */
  stopped?: (code: number) => void;
};

/**
 * Serves an app the way a deploy needs: it listens first, so the platform
 * sees it's up (requests are told it's starting), takes the store's lease if
 * it's given one (`hold`), then opens the app and serves it. It stops when
 * its `signal` aborts (SIGTERM), when `stop` is called, or when a newer
 * process asks for the lease: it stops listening (its sockets close, and
 * browsers reconnect, to the newer process), the app's running work gets
 * `drain` to finish, and the lease goes to whoever waits. A process that
 * loses the lease stops too, rather than write beside another, and so does
 * one whose app loses its store (`app.lost`: another process opened it,
 * without a lease or past it): a runtime has stopped serving by then, and
 * logged why. Stopped by itself, the process exits (`stopped`).
 *
 * It rejects when it stops before the app is open, or the app fails to open.
 * What the app's `open` opened (its pool) stays the app's to close.
 */
export async function serve<A extends App>(
  open: () => Promise<A>,
  options: ServeOptions = {},
): Promise<{ app: A; server: Listener; stop(): Promise<void> }> {
  const {
    hold,
    starting = startingPage,
    drain = 8_000,
    stopped = exit,
    signal,
    ...where
  } = options;
  signal?.throwIfAborted();
  /** The app once it's open; until then, requests are told it's starting. */
  let app: A | undefined;
  const server = await listen((request) => app ? app.fetch(request) : starting(request), where);
  const waiting = new AbortController();
  let held: { release(): Promise<void> } | undefined;
  let opening: Promise<A> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    stopping ??= (async () => {
      waiting.abort(new DOMException("It stopped before the app opened", "AbortError"));
      try {
        await server.shutdown();
      } finally {
        try {
          // An app still opening closes once it's open.
          await (await opening?.catch(() => undefined))?.close({ drain });
        } finally {
          await held?.release();
        }
      }
    })();
  let said = false;
  /** It stops by itself (or by its signal), and says so, once. */
  const stopBy = (code: number, why?: string) => {
    if (said) return;
    said = true;
    if (why) (code ? console.error : console.log)(why);
    void stop().finally(() => stopped(code));
  };
  const aborted = () => stopBy(0);
  signal?.addEventListener("abort", aborted, { once: true });
  try {
    if (hold) {
      held = await hold({
        signal: waiting.signal,
        waiting: () => console.log("Waiting for the previous process to let go of the store…"),
        asked: () => stopBy(0, "A newer process asks for the store: handing over"),
        lost: (why) => stopBy(1, `Lost the store's lease (${why}): stopping`),
      });
      // Taken just as it stopped: let go of it again.
      if (stopping) await held.release();
      waiting.signal.throwIfAborted();
    }
    opening = open();
    app = await opening;
    // It lost its store: it logged so, and answers 503 meanwhile.
    void app.lost?.then(() => stopBy(1));
  } catch (error) {
    signal?.removeEventListener("abort", aborted);
    await stop();
    throw error;
  }
  return { app, server, stop };
}

/** While it waits for the store: a page that tries again by itself, or a 503 to retry. */
function startingPage(request: Request): Response {
  const headers = { "retry-after": "2" };
  if (request.method === "GET" && request.headers.get("accept")?.includes("text/html")) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        "<title>Starting</title><p>Starting, one moment…</p>",
      { status: 503, headers: { ...headers, "content-type": "text/html; charset=utf-8" } },
    );
  }
  return Response.json({ error: "starting" }, { status: 503, headers });
}
