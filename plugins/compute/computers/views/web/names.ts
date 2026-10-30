/**
 * How a computer and what's on it are named on the web: the computer (its
 * person's name for it, or its host's), its system ("macOS", "Linux"), a
 * folder under a home ("~/Copilotz"), a space's folder there, whose a job
 * is ("you", "assistant"), and the person's own work there: `computer.work`
 * in one space's folder (`as` an agent, for that agent's jobs).
 */
import type { Computer } from "../../collections/computer.ts";
import type { Info } from "../../shared/workloads.ts";

/** What the computer goes by. */
export const nameOf = (c: Pick<Computer, "name" | "info">): string =>
  c.name || (c.info as Partial<Info> | undefined)?.hostname || "Computer";

/** Node's names for systems, as people say them. */
const SYSTEMS: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
  freebsd: "FreeBSD",
  openbsd: "OpenBSD",
  android: "Android",
};

export const systemOf = (os?: string): string | undefined => os && (SYSTEMS[os] ?? os);

/** A path under a home folder, from `~`: `/Users/ana/Copilotz` is `~/Copilotz`. */
export const tilde = (path: string): string =>
  path.replace(
    /^(?:\/Users|\/home)\/[^/]+(?=\/|$)|^\/root(?=\/|$)|^[A-Z]:\\Users\\[^\\]+(?=\\|$)/,
    "~",
  );

/** Where a folder (a desk's) is on the computer, once it says where its root is. */
export function folderPath(c: Pick<Computer, "info">, folder: string): string | undefined {
  const root = (c.info as Partial<Info> | undefined)?.root;
  if (!root) return undefined;
  return `${tilde(root)}${root.includes("\\") ? "\\" : "/"}${folder}`;
}

/** An agent as it's named, with its emoji (chat's `thread.agents` says). */
export type Named = { name: string; icon?: string };

/**
 * Whose a job or a shell is, by its `who` (`agent:<name>`, `person:<id>`),
 * for `me`: an agent as it's named (`agents`), with its emoji.
 */
export function whose(
  who: string,
  me?: string,
  agents: Record<string, Named> = {},
): { name: string; icon?: string; agent: boolean; mine: boolean } {
  const at = who.indexOf(":");
  const kind = at < 0 ? "" : who.slice(0, at);
  const id = at < 0 ? who : who.slice(at + 1);
  const mine = kind === "person" && id === me;
  const agent = kind === "agent" ? agents[id] : undefined;
  return {
    name: mine ? "you" : agent?.name ?? id,
    ...(agent?.icon ? { icon: agent.icon } : {}),
    agent: kind === "agent",
    mine,
  };
}

/** What `thread.agents` says of agents, as names and emoji. */
export const namedOf = (agents: Record<string, { name?: string; icon?: string }> = {}) =>
  Object.fromEntries(
    Object.entries(agents).map((
      [id, a],
    ) => [id, { name: a.name || id, ...(a.icon ? { icon: a.icon } : {}) }]),
  ) as Record<string, Named>;

/** The person's work at a desk (a computer, in one space): `computer.work`, answered (or failing, saying why). */
export type Work = <T = unknown>(
  work: string,
  input?: Record<string, unknown>,
  as?: string,
) => Promise<T>;

export const workOn = (
  call: <R = unknown>(action: string, input?: unknown) => Promise<R>,
  desk: string,
): Work =>
(work, input = {}, as) =>
  call("computer.work", {
    desk,
    work,
    input,
    // Only an agent's jobs are reached as someone else: the person's own are theirs.
    ...(as?.startsWith("agent:") ? { as } : {}),
  });
