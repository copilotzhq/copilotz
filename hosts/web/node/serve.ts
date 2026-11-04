/**
 * The web host's server half on Node, through Oxian's Node adapter. Node
 * hands a browser's socket over as an upgrade, not a request, so the socket's
 * path (`/oxian`) goes to a runtime's Hypervisor before any handler runs;
 * everything else is a `Request` for the app's fetch handler (`webServer`,
 * plugins' routes included, as on any runtime). Bun and Deno run it too,
 * through their Node compatibility.
 *
 * - `serve`: one runtime's web host (`webServer`), its socket to that runtime.
 * - `serveRoutes`: an app without the web app (on WhatsApp, on the phone):
 *   its routes alone (`routeHost`), and `/health`.
 * - `listen`: any fetch handler, with the Hypervisor each socket goes to
 *   picked per request: a host with a runtime per org names the one a request
 *   is for (`hosts/orgs`: its `openRuntime`).
 *
 * A route may take a socket of its own (`host.upgrade()`, see `routes.ts`):
 * any path but the runtime's goes to the handler, upgrades too, and Oxian's
 * adapter takes the socket the handler accepts.
 */
import type { Hypervisor, HypervisorRequestDecision } from "@oxian/oxian-js";
import { serve as oxian } from "@oxian/oxian-js/adapters/node";
import type { Runtime } from "../../../runtime/mod.ts";
import { type Front, hostRouted, routeHost } from "../routes.ts";
import { socket, webServer, type WebServerOptions } from "../server.ts";

/** Where to listen. */
type Address = {
  /** `127.0.0.1` by default (this machine only); `0.0.0.0` for everyone's. */
  hostname?: string;
  /** The port; a free one by default (the listener's `url` says which). */
  port?: number;
  /** Stops listening when it aborts. */
  signal?: AbortSignal;
};

export type ServeOptions = Omit<WebServerOptions, "upgrade"> & Address;

export type ListenOptions = Address & {
  /** Answers every request but a socket's: the app's fetch handler. */
  fetch(request: Request): Response | Promise<Response>;
  /**
   * The Hypervisor a request to the socket's path goes to (its runtime's), or
   * none, for `fetch` to answer (`503`: the client connects again). It
   * decides at once: Node upgrades the socket before anything asynchronous
   * could run.
   */
  hypervisor(request: Request): Hypervisor | undefined;
};

/** A server listening: where, when it's done, and how to stop it (runtimes stay the app's). */
export type Listener = {
  hostname: string;
  port: number;
  url: URL;
  finished: Promise<void>;
  shutdown(): Promise<void>;
};

export type RoutesOptions = Address & {
  runtime: Runtime;
  /** The app's front (a Cloudflare worker before it), as `webServer` takes it. */
  front?: Front;
};

/** A route host listening. It owns its runtime: `close` stops listening, then closes it. */
export type RouteListener = Listener & {
  /** Stops listening (its sockets close), then the runtime, passing `drain` on (`Runtime.close`). */
  close(options?: { drain?: number }): Promise<void>;
};

/**
 * Serves the web host for a runtime that declares the `socket` transport
 * (`createRuntime({ transports: [socket], admit: tickets.admit })`).
 */
export async function serve(options: ServeOptions): Promise<Listener> {
  const { hostname, port, signal, ...web } = options;
  const hypervisor: Hypervisor = web.runtime.hypervisor;
  const routed = hostRouted(web.runtime, web.front ? { front: web.front } : {});
  return await listen({
    // Every request for the socket goes to the Hypervisor, so `webServer` never upgrades one;
    // a host a route takes (a preview's) has no socket of the app's, though.
    fetch: webServer({ ...web, upgrade: () => new Response(null, { status: 426 }) }),
    hypervisor: (request) => routed(request) ? undefined : hypervisor,
    hostname,
    port,
    signal,
  });
}

/**
 * Serves an app's routes alone (`routeHost`): its webhooks and sockets, and
 * `/health`. Its runtime's own socket (`/oxian`, when it declares one: remote
 * executors) goes to it, as `serve`'s does.
 */
export async function serveRoutes(options: RoutesOptions): Promise<RouteListener> {
  const { runtime, front, ...address } = options;
  const routed = hostRouted(runtime, front ? { front } : {});
  const listener = await listen({
    ...address,
    fetch: routeHost(runtime, front ? { front } : {}),
    hypervisor: (request) => routed(request) ? undefined : runtime.hypervisor,
  });
  // Closing takes a while (the runtime's drain): asked again, it's the same close.
  let closed: Promise<void> | undefined;
  // What it's given goes on to the runtime's close: how long running work may take to finish.
  const owned: { close(options?: { drain?: number }): Promise<void> } = runtime;
  return {
    ...listener,
    close: (options) => closed ??= listener.shutdown().then(() => owned.close(options)),
  };
}

/** Serves a fetch handler, each socket going to the Hypervisor `hypervisor` picks for it. */
export async function listen(options: ListenOptions): Promise<Listener> {
  const { hostname = "127.0.0.1", port = 0, signal } = options;
  const prepare = (request: Request): HypervisorRequestDecision => {
    // The socket's path, or a runtime's own under it (an org's: `/o/<org>/oxian`).
    const path = new URL(request.url).pathname;
    const to = path === socket.config.path || path.endsWith(socket.config.path)
      ? options.hypervisor(request)
      : undefined;
    return to ? to.prepare(request) : { kind: "response", response: options.fetch(request) };
  };
  // Oxian's adapter asks what it serves only to prepare requests, after asking once if it's open.
  const front = { prepare, snapshot: () => ({ acceptingConnections: true }) };
  return await oxian({ hypervisor: front as unknown as Hypervisor, hostname, port, signal });
}
