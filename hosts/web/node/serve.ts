/**
 * The web host's server half on Node, through Oxian's Node adapter. Node
 * hands a browser's socket over as an upgrade, not a request, so the socket's
 * path (`/oxian`) goes to a runtime's Hypervisor before any handler runs;
 * everything else is a `Request` for the app's fetch handler (`webServer`,
 * plugins' routes included, as on any runtime). Bun and Deno run it too,
 * through their Node compatibility.
 *
 * - `serve`: one runtime's web host (`webServer`), its socket to that runtime.
 * - `listen`: any fetch handler, with the Hypervisor each socket goes to
 *   picked per request: a host with a runtime per org names the one a request
 *   is for (`hosts/orgs`: its `openRuntime`).
 */
import type { Hypervisor, HypervisorRequestDecision } from "@oxian/oxian-js";
import { serve as oxian } from "@oxian/oxian-js/adapters/node";
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

/**
 * Serves the web host for a runtime that declares the `socket` transport
 * (`createRuntime({ transports: [socket], admit: tickets.admit })`).
 */
export async function serve(options: ServeOptions): Promise<Listener> {
  const { hostname, port, signal, ...web } = options;
  const hypervisor: Hypervisor = web.runtime.hypervisor;
  return await listen({
    // Every request for the socket goes to the Hypervisor, so `webServer` never upgrades one.
    fetch: webServer({ ...web, upgrade: () => new Response(null, { status: 426 }) }),
    hypervisor: () => hypervisor,
    hostname,
    port,
    signal,
  });
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
