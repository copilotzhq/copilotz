/**
 * What other front ends add to computers' pages, through two resources
 * (data only: their Views do the rest):
 *
 * - `computerKinds`: kinds of computer beyond people's own machines (cloud
 *   computers, which the app keeps, and which sleep and wake). Each names
 *   the query that lists the person's computers of the kind, and its View,
 *   which computers' pages show for those computers (item `{ _id }`, the
 *   computer; `hints.mode`): `badge` beside its name (its state), `facts`
 *   in its page's header, and `asleep` in place of its terminal, jobs and
 *   files while it's offline (item `{ _id, desk, name }`; `hints.wake`: wake
 *   it now, as opening its page does). `add` makes one in a space, beside
 *   connecting your own machine (its View, item `{ _id }`, the space): when
 *   the person can't now (its `available` query answers `create: false`),
 *   the choice shows why (`unavailable`, by its `why`) and can't be picked; and
 *   `remove` takes one away in place of forgetting it (an Action, input
 *   `{ computer }`, and what to say first).
 * - `jobActions`: what else a job that serves a port can become (published
 *   as an app): a View drawn in the job's row (item: `JobServed`).
 */
import type { IconName } from "../../../../../hosts/web/mod.ts";

export type ComputerKind = {
  /** What one is called: "Cloud computer". */
  title: string;
  icon?: IconName;
  /** The query listing the person's computers of this kind, `<collection>.<query>`: records whose `_id` is the computer's. */
  mine: string;
  view: string;
  add?: {
    view: string;
    /** As the choice says it: "Use a cloud computer", and what it means, in a line. */
    title: string;
    description: string;
    /** The dialog's title once it's chosen: "New cloud computer". */
    heading?: string;
    /** A query (`<collection>.<query>`) saying whether the person may make one now: `{ create, why? }`. */
    available?: string;
    /** What the choice says when they can't, by the query's `why` (`default` for any other). */
    unavailable?: Record<string, string>;
  };
  remove?: {
    action: string;
    /** The menu's item ("Delete this computer"); the confirm's title, `{name}` the computer's; what it means; its button. */
    label: string;
    title: string;
    text: string;
    button: string;
  };
  order?: number;
};

export type Kind = ComputerKind & {
  key: string;
  /** Why the person can't make one here now (its `add`'s `available` said so), when they can't. */
  blocked?: string;
};

/** Whether a kind can be made now, from what its `available` query answered: why not, else nothing. */
export function blockedBy(kind: ComputerKind, answer: unknown): string | undefined {
  const said = answer as { create?: unknown; why?: unknown } | null | undefined;
  if (!kind.add?.available || !said || said.create !== false) return undefined;
  const why = typeof said.why === "string" ? said.why : "";
  return kind.add.unavailable?.[why] ?? kind.add.unavailable?.default ??
    "You can't make one here now.";
}

/** A collection's query, by its name (`cloud.mine`): the collection, and the query. */
export function queryOf(name: string): [string, string] | undefined {
  const at = name.lastIndexOf(".");
  return at > 0 && at < name.length - 1 ? [name.slice(0, at), name.slice(at + 1)] : undefined;
}

/** The kinds given, lowest `order` first (by key when they tie), leaving out those taken away or incomplete. */
export function kindsOf(given: unknown): Kind[] {
  return Object.entries((given ?? {}) as Record<string, ComputerKind | null>)
    .flatMap(([key, kind]) =>
      kind?.view && kind.title && kind.mine && queryOf(kind.mine) ? [{ ...kind, key }] : []
    )
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key));
}

/** Each computer of a kind, by its id: from each kind's records (undefined while they load). */
export function kindByComputer(
  kinds: Kind[],
  records: (readonly { _id: string }[] | null | undefined)[],
): Record<string, Kind> {
  const out: Record<string, Kind> = {};
  kinds.forEach((kind, i) => {
    for (const r of records[i] ?? []) out[r._id] ??= kind;
  });
  return out;
}

/** A kind's remove confirm's title, for one computer. */
export const titled = (template: string, name: string) => template.replaceAll("{name}", name);

/** A `jobActions` resource: a View drawn in the row of a job that serves a port. */
export type JobAction = { view: string; order?: number };

/** What a job action's View is given: the job, where it runs, and what it serves. */
export type JobServed = {
  /** The space, and its computer. */
  in: string;
  computer: string;
  /** The computer's desk in the space, when it's known: what's published comes from it. */
  desk?: string;
  job: string;
  /** What the job goes by (its name, else its command): a name to start from. */
  name: string;
  command: string;
  /** The port it serves (said, else the first it listens on), and every one it listens on. */
  port?: number;
  ports?: number[];
  /** The space's folder on the computer, as it shows (`~/Copilotz/acme`). */
  folder?: string;
};

export function jobActionsOf(given: unknown): (JobAction & { key: string })[] {
  return Object.entries((given ?? {}) as Record<string, JobAction | null>)
    .flatMap(([key, action]) => action?.view ? [{ ...action, key }] : [])
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key));
}
