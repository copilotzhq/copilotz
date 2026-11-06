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
 */
import type { Hypervisor } from "@oxian/oxian-js";
import { serve as oxian } from "@oxian/oxian-js/adapters/node";
import { upgradeOf } from "../../../runtime/fetch.ts";

/** Where to listen. */
export type ListenOptions = {
  /** `127.0.0.1` by default (this machine only); `0.0.0.0` for everyone's. */
  hostname?: string;
  /** The port; a free one by default (the listener's `url` says which). */
  port?: number;
  /** Stops listening when it aborts. */
  signal?: AbortSignal;
};

/** A server listening: where, when it's done, and how to stop it (runtimes stay the app's). */
export type Listener = {
  hostname: string;
  port: number;
  url: URL;
  finished: Promise<void>;
  /** Stops listening; its sockets close. */
  shutdown(): Promise<void>;
};

/** Serves a fetch handler (`runtime.fetch`): every request, sockets' upgrades included. */
export async function listen(
  fetch: (request: Request) => Response | Promise<Response>,
  options: ListenOptions = {},
): Promise<Listener> {
  const { hostname = "127.0.0.1", port = 0, signal } = options;
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
  return await oxian({ hypervisor: front as unknown as Hypervisor, hostname, port, signal });
}
