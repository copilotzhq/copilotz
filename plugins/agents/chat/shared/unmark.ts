/**
 * Taking the old marks off messages. Before the audience rule, an answer
 * that drew on what not everyone where it was could see kept those spaces
 * as `sources`, and only those who reached them all read it. Marks no longer
 * hide anything, so each marked message goes where only those who could read
 * it see it, and its marks become its record of what it drew on (`drew`):
 *
 * - **In someone's Personal space** (`personal`): only they see it, as
 *   before: its marks just become `drew`, every id of them.
 * - **In a chat shared with someone outside its space** (`contactChats`: a
 *   contact's, who never saw it): into that chat's notes (made if need be),
 *   as it was, at its time, which only the space's people see.
 * - **Anywhere else** (`held`: a shared space, rare): to the Personal space
 *   of the person it was for (whom it was to, else whom its turn answered),
 *   in a thread "Held from <title>", with a line where it was saying so (a
 *   placeholder, by its author, at its time, with nothing of what it said).
 * - **Nobody to hold it for** (`unresolved`): into a thread in no space,
 *   which no one but the system reads, with a placeholder where it was.
 *
 * Planning only reads (`Reads`: the runtime's collections as the system, or
 * a store as it is, for a dry run against a database nobody writes); the
 * Action applies each batch in a transaction. A message it moved has no
 * marks, so running it again finds nothing to do.
 */
import type { Doc, Filter, Store } from "../../../../runtime/mod.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import { notesFor, notesOf } from "./notes.ts";
import { nameOf, namesOf, PERSONAL, PROFILE } from "../../../access/spaces/contract.ts";

/** What a migration reads with: plain documents, as the store keeps them. */
export type Reads = {
  find(
    collection: string,
    filter: Filter,
    options?: { sort?: Record<string, 1 | -1>; limit?: number },
  ): Promise<Doc[]>;
  findOne(collection: string, filter: Filter): Promise<Doc | null>;
};

/**
 * A store's reads, as they are: committed documents, with no owner, so a dry
 * run against a database (a copy of production's) claims nothing and writes
 * nothing.
 */
export const storeReads = (store: Pick<Store, "find" | "findOne">): Reads => ({
  find: (collection, filter, options) => store.find(collection, filter, options),
  findOne: (collection, filter) => store.findOne(collection, filter),
});

/** Where a marked message went, by kind. */
export type Kind = "personal" | "contactChats" | "held" | "unresolved";

export type Counts = Record<Kind, number> & { placeholders: number };

/** What a message with marks looks like: the fields this reads. */
export type Marked = Message & { sources?: string[] };

/** One message's move: where it goes (no `thread` when it stays), and what it leaves. */
export type Step = {
  message: Marked;
  kind: Kind;
  /** The thread it goes to, when it moves. */
  thread?: string;
  /** The space it goes to: null for none (held out of every space). */
  in?: string | null;
  /** Its record of what it drew on, its marks merged in. */
  drew: string[];
  /** What's said where it was, when it moved out of a shared conversation. */
  placeholder?: Message;
};

/** A batch's plan: each message's step, the threads to make first, and whose Personal space. */
export type Plan = { steps: Step[]; threads: Thread[]; personal: string[] };

/** A space, as this reads it. */
type Place = { _id: string; kind?: string; owner?: string };

/** What one batch's planning knows already, kept across batches. */
export type Known = {
  threads: Map<string, Thread | null>;
  spaces: Map<string, Place | null>;
  shared: Map<string, boolean>;
  people: Map<string, boolean>;
  names: Map<string, string>;
  /** Threads planned already (made, or to be made): each is made once. */
  made: Set<string>;
  /** Personal spaces planned already. */
  personal: Set<string>;
};

export const known = (): Known => ({
  threads: new Map(),
  spaces: new Map(),
  shared: new Map(),
  people: new Map(),
  names: new Map(),
  made: new Set(),
  personal: new Set(),
});

/** Messages with marks, a batch at a time, after `after` (by id). */
export const marked = (reads: Reads, after: string, limit: number) =>
  reads.find("message", {
    sources: { $exists: true },
    ...(after ? { _id: { $gt: after } } : {}),
  }, { sort: { _id: 1 }, limit }) as Promise<Marked[]>;

/** The id of the thread holding a shared conversation's marked messages for `person` (none: no one's). */
export const heldOf = (thread: string, person?: string) =>
  person ? `${thread}:held:${person}` : `${thread}:held`;

/** A Personal space's id, as spaces makes it. */
const personalOf = (person: string) => `personal:${person}`;

const PERSON = "person:";

async function threadOf(reads: Reads, known: Known, id: string) {
  if (!known.threads.has(id)) {
    known.threads.set(id, (await reads.findOne("thread", { _id: id })) as Thread | null);
  }
  return known.threads.get(id) ?? null;
}

async function spaceOf(reads: Reads, known: Known, id: string | undefined) {
  if (!id) return null;
  if (!known.spaces.has(id)) {
    known.spaces.set(id, (await reads.findOne("space", { _id: id })) as Place | null);
  }
  return known.spaces.get(id) ?? null;
}

/** Whether a chat is shared on its own with someone outside its space (a contact). */
async function sharedOutside(reads: Reads, known: Known, thread: string) {
  if (!known.shared.has(thread)) {
    const outside = await reads.find("member", { space: `thread:${thread}` }, { limit: 1 });
    known.shared.set(thread, outside.length > 0);
  }
  return known.shared.get(thread)!;
}

/** Whether an id in a message's `to` is a person: someone who's a member of something. */
async function isPerson(reads: Reads, known: Known, id: string) {
  if (!id || id.includes(":")) return false;
  if (!known.people.has(id)) {
    const found = await reads.findOne("member", { member: `${PERSON}${id}` }) ??
      await reads.findOne("space", { _id: personalOf(id) });
    known.people.set(id, !!found);
  }
  return known.people.get(id)!;
}

/**
 * The person a marked message was for: whom it was to; else, for an agent's
 * step, whom its turn's answer was to; else who wrote what it replies to.
 */
async function personFor(reads: Reads, known: Known, m: Marked): Promise<string | undefined> {
  const answer = m.turn && m._id !== `${m.turn}:reply`
    ? (await reads.findOne("message", { _id: `${m.turn}:reply` })) as Message | null
    : null;
  const asked = m.replyTo
    ? (await reads.findOne("message", { _id: m.replyTo })) as Message | null
    : null;
  for (const id of [...m.to ?? [], ...answer?.to ?? [], ...(asked ? [asked.from] : [])]) {
    if (await isPerson(reads, known, id)) return id;
  }
  return undefined;
}

async function nameFor(reads: Reads, known: Known, person: string) {
  if (!known.names.has(person)) {
    const profile = await reads.findOne(PROFILE, { _id: person }) as
      | { _id: string; name?: string }
      | null;
    known.names.set(person, nameOf(person, namesOf(profile ? [profile] : [])));
  }
  return known.names.get(person)!;
}

/** A message's marks, merged into its record of what it drew on (but where it now is, `space`). */
const drewOf = (m: Marked, space?: string) =>
  [...new Set([...m.drew ?? [], ...m.sources ?? []])].filter((id) => id !== space).sort();

/** The line left where a marked message was, by its author, at its time: none of what it said. */
const placeholder = (m: Marked, space: string | undefined, text: string): Message => ({
  _id: `${m._id}:held`,
  thread: m.thread,
  ...(space ? { in: space } : {}),
  from: m.from,
  to: [],
  text,
  at: m.at,
});

/** What to do with a batch of marked messages. */
export async function planOf(
  reads: Reads,
  known: Known,
  batch: Marked[],
  now: string,
): Promise<Plan> {
  const plan: Plan = { steps: [], threads: [], personal: [] };
  const make = (thread: Thread) => {
    if (known.made.has(thread._id)) return;
    known.made.add(thread._id);
    plan.threads.push(thread);
  };
  for (const m of batch) {
    const chat = await threadOf(reads, known, m.thread);
    const space = chat?.in ?? m.in;
    // A contact's chat: into its notes, which they never see.
    if (chat && await sharedOutside(reads, known, chat._id)) {
      const notes = notesOf(chat._id);
      if (!await threadOf(reads, known, notes)) make(notesFor(chat, now));
      plan.steps.push({ message: m, kind: "contactChats", thread: notes, drew: drewOf(m, space) });
      continue;
    }
    const where = await spaceOf(reads, known, space);
    // Someone's Personal space: only they see it, as before.
    if (where?.kind === PERSONAL) {
      // Its record keeps every id: only its person reads it, and they reached them all.
      plan.steps.push({ message: m, kind: "personal", drew: drewOf(m) });
      continue;
    }
    const title = `Held from ${chat?.title ?? "a conversation"}`.slice(0, 120);
    const shared = !m.private;
    const person = await personFor(reads, known, m);
    if (person) {
      // The Personal space of the person it was for, in a thread holding what came from there.
      const home = personalOf(person);
      if (!known.personal.has(person) && !await spaceOf(reads, known, home)) {
        known.personal.add(person);
        plan.personal.push(person);
      }
      const held = heldOf(m.thread, person);
      if (!await threadOf(reads, known, held)) {
        make({ _id: held, title, agents: [], in: home, messages: 0, at: now });
      }
      const name = await nameFor(reads, known, person);
      plan.steps.push({
        message: m,
        kind: "held",
        thread: held,
        in: home,
        drew: drewOf(m, home),
        ...(shared
          ? {
            placeholder: placeholder(
              m,
              space,
              `A reply only ${name} could see was moved to their Personal space.`,
            ),
          }
          : {}),
      });
      continue;
    }
    // Nobody to hold it for: out of every space, which only the system reads.
    const held = heldOf(m.thread);
    if (!await threadOf(reads, known, held)) {
      make({ _id: held, title, agents: [], messages: 0, at: now });
    }
    plan.steps.push({
      message: m,
      kind: "unresolved",
      thread: held,
      in: null,
      drew: drewOf(m, undefined),
      ...(shared
        ? {
          placeholder: placeholder(m, space, "A reply only some here could see was held back."),
        }
        : {}),
    });
  }
  return plan;
}

/** How many of each kind a plan holds. */
export function counted(plan: Plan, into: Counts): Counts {
  for (const step of plan.steps) {
    into[step.kind]++;
    if (step.placeholder) into.placeholders++;
  }
  return into;
}

export const noCounts = (): Counts => ({
  personal: 0,
  contactChats: 0,
  held: 0,
  unresolved: 0,
  placeholders: 0,
});

/** What a run did, or would (`dryRun`): counts by kind, and on a dry run what it would touch. */
export type Unmarked = {
  dryRun: boolean;
  counts: Counts;
  /** Threads made (or that would be): notes beside contacts' chats, and held ones. */
  threads: string[];
  /** Personal spaces made (or that would be) to hold what was their people's. */
  spaces: string[];
  /** On a dry run: each message it would move or change, by kind, from where to where. */
  messages?: { _id: string; kind: Kind; thread: string; to?: string }[];
  /** On a dry run: the placeholders it would leave. */
  placeholders?: string[];
};

/** The line a run logs: what it did, or would, by kind. */
export type UnmarkLog =
  & { severity: "NOTICE"; migration: "chat.unmark"; dryRun: boolean }
  & Counts
  & { threads: number; spaces: number; at: string };

/**
 * Plans every marked message, a batch at a time, and unless it's a dry run
 * applies each batch (`apply`) before reading the next; then logs what it
 * did, by kind (`quiet`: not when there was nothing to do, as on a store
 * that never had marks). A dry run reads, and writes nothing.
 */
export async function unmark(
  reads: Reads,
  options: {
    dryRun?: boolean;
    batch?: number;
    apply?: (plan: Plan) => Promise<void>;
    now?: () => string;
    log?: (line: UnmarkLog) => void;
    quiet?: boolean;
  } = {},
): Promise<Unmarked> {
  const dryRun = options.dryRun ?? !options.apply;
  const now = options.now ?? (() => new Date().toISOString());
  const kept = known();
  const counts = noCounts();
  const done: Unmarked = { dryRun, counts, threads: [], spaces: [] };
  const messages: NonNullable<Unmarked["messages"]> = [];
  const placeholders: string[] = [];
  for (let after = "";;) {
    const batch = await marked(reads, after, options.batch ?? 100);
    if (!batch.length) break;
    const plan = await planOf(reads, kept, batch, now());
    if (!dryRun) await options.apply!(plan);
    counted(plan, counts);
    done.threads.push(...plan.threads.map((t) => t._id));
    done.spaces.push(...plan.personal.map(personalOf));
    if (dryRun) {
      for (const step of plan.steps) {
        messages.push({
          _id: step.message._id,
          kind: step.kind,
          thread: step.message.thread,
          ...(step.thread ? { to: step.thread } : {}),
        });
        if (step.placeholder) placeholders.push(step.placeholder._id);
      }
    }
    after = batch[batch.length - 1]._id;
  }
  const found = Object.values(counts).some((n) => n > 0);
  const log = options.log ?? ((line: UnmarkLog) => console.log(JSON.stringify(line)));
  if (found || !options.quiet) {
    log({
      severity: "NOTICE",
      migration: "chat.unmark",
      dryRun,
      ...counts,
      threads: done.threads.length,
      spaces: done.spaces.length,
      at: now(),
    });
  }
  return dryRun ? { ...done, messages, placeholders } : done;
}
