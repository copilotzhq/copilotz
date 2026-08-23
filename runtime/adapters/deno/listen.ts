import { serve } from "../../../dependencies/oxian-deno.ts";
import type {
  Hypervisor,
  HypervisorListener,
} from "../../../dependencies/oxian-hypervisor.ts";

export type ListenCopilotzOptions = Readonly<{
  hostname?: string;
  port?: number;
  signal?: AbortSignal;
}>;

/** Structural host boundary: application factories are not adapter dependencies. */
export type FetchCapableHost = Readonly<{
  fetch?: (request: Request) => Promise<Response>;
  hypervisor?: Hypervisor;
}>;

function listenerUrl(hostname: string, port: number): URL {
  const host = hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
  return new URL(`http://${host}:${port}/`);
}

/** Starts a Deno listener while keeping the public operation name portable. */
export function listen(
  gateway: FetchCapableHost,
  options: ListenCopilotzOptions = {},
): HypervisorListener {
  if (gateway.hypervisor) {
    return serve({
      hypervisor: gateway.hypervisor,
      hostname: options.hostname,
      port: options.port,
      signal: options.signal,
    });
  }
  if (!gateway.fetch) {
    throw new TypeError("Copilotz listener requires a Fetch-capable host.");
  }

  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;
  const server = Deno.serve({
    hostname,
    port,
    signal: options.signal,
    onListen() {},
  }, gateway.fetch);
  if (server.addr.transport !== "tcp") {
    throw new TypeError("Copilotz Gateway listener requires a TCP address.");
  }
  let shutdownTask: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownTask) return shutdownTask;
    shutdownTask = server.shutdown().catch(() => undefined);
    return shutdownTask;
  };
  return Object.freeze({
    hostname: server.addr.hostname,
    port: server.addr.port,
    url: listenerUrl(server.addr.hostname, server.addr.port),
    finished: server.finished,
    shutdown,
  });
}
