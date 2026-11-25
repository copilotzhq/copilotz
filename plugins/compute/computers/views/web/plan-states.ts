/**
 * A person's plans, as Your AI and the connect flow show them, in plain
 * functions: the plans the app uses, each with its ways in (a CLI on a
 * computer, or a sign-in on the server), from the app's tiers when it has
 * them (the `planList` resource: their list, in the person's order) or
 * else every plan the app has; how a plan stands for the person (a card's
 * state: ready on a computer or the server, with its backup; off on the
 * computers it's signed in on; needing them; not connected); a computer as
 * a plan needs it (shared with others' agents, reachable); and a CLI's
 * sign-in: asked again until it's done, its output and links as they're
 * safe to show.
 */
import type { Account, ProviderShown } from "../../../../access/accounts/contract.ts";
import type { Computer } from "../../collections/computer.ts";
import type { Desk } from "../../collections/desk.ts";
import type { EngineName, EngineSeen } from "../../shared/engines.ts";
import { servingOrder } from "../../shared/serving.ts";
import { say } from "./words.ts";

/** Each plan provider of the computers plugin's, and the engine (the CLI) it runs on. */
export const ENGINE_OF: Readonly<Record<string, EngineName>> = {
  "claude-plan": "claude",
  "codex-plan": "codex",
  "gemini-plan": "antigravity",
  "grok-plan": "grok",
};

/** A CLI's name, as people know it. */
export const cliOf = (engine: EngineName): string =>
  ({
    claude: say("claudeCli"),
    codex: say("codexCli"),
    antigravity: say("antigravityCli"),
    grok: say("grokCli"),
  })[engine] ?? engine;

/** A way into a plan: a CLI on a computer (`engine`), or a sign-in on the server (`account`). */
export type Way = {
  /** Its model provider: `claude-plan`, `chatgpt`. */
  provider: string;
  /** What it's called: "ChatGPT plan, through Codex". */
  title: string;
  /** The plan it's a way into, as people know it ("ChatGPT plan"): ways of a plan show as one. */
  plan: string;
  engine?: EngineName;
  /** The account provider that signs it in (`accountProviders`, whose `models` name it). */
  account?: string;
  /** What a test tries on it (`llm.test`): the first model the app's chains use there. */
  model?: string;
  /** Signed in, as the app's list says (a CLI's, on a computer of theirs; an account). */
  connected?: boolean;
};

/** A plan, and its ways in, in the person's order. */
export type PlanShown = { plan: string; ways: Way[] };

/**
 * A plan as the app's tiers list them (`planList`'s query, the tiers'
 * `modelChoice.harnesses`: the plans the app uses, in the person's order,
 * each marked connected or not), as far as the web reads it: its provider
 * (`name`), and the first model the app's chains use on it (`model`).
 */
export type Listed = {
  name: string;
  title?: string;
  plan?: string;
  model?: string;
  connected?: boolean;
};

/**
 * The `planList` resource: the query that lists the plans the app uses, in
 * the person's order (`<collection>.<query>`), and the Action that saves
 * their order, `{ harnesses: string[] | null }` (null: the app's own). The tiers
 * front end gives it; without it, every plan the app has shows, in its order.
 */
export type PlanList = { query: string; order?: string };

/**
 * The plans to show, each with its ways in that this front end can connect:
 * as the app's tiers list them (`listed`), else every plan the app has: the
 * accounts that pay for models (ChatGPT, on the server), then each CLI.
 */
export function plansOf(listed: Listed[] | undefined, accounts: ProviderShown[]): PlanShown[] {
  const accountOf = (provider: string) => accounts.find((a) => a.models?.includes(provider));
  const ways: Way[] = listed
    ? listed.flatMap((h): Way[] => {
      const engine = ENGINE_OF[h.name];
      const account = accountOf(h.name)?.name;
      if (!engine && !account) return [];
      const title = h.title ?? h.name;
      return [{
        provider: h.name,
        title,
        plan: h.plan ?? title,
        ...(engine ? { engine } : {}),
        ...(account ? { account } : {}),
        ...(h.model ? { model: h.model } : {}),
        ...(h.connected !== undefined ? { connected: h.connected } : {}),
      }];
    })
    : [
      ...accounts.filter((a) => a.models?.length).map((a): Way => ({
        provider: a.models![0],
        title: a.title,
        plan: a.title,
        account: a.name,
      })),
      ...Object.entries(ENGINE_OF).map(([provider, engine]): Way => {
        const title = titleOf(engine);
        return { provider, title, plan: title, engine };
      }),
    ];
  const plans: PlanShown[] = [];
  for (const way of ways) {
    const found = plans.find((p) => p.plan === way.plan);
    if (found) found.ways.push(way);
    else plans.push({ plan: way.plan, ways: [way] });
  }
  return plans;
}

/** A plan's name, as the app's own computers name it (without tiers to list them). */
const titleOf = (engine: EngineName): string =>
  ({
    claude: say("claudeTitle"),
    codex: say("codexTitle"),
    antigravity: say("antigravityTitle"),
    grok: say("grokTitle"),
  })[engine];

/** The ways the flow connects for each plan picked: its first, unless one was asked for. */
export const waysFor = (plans: PlanShown[], picked: string[]): Way[] =>
  plans.flatMap((p) => {
    const asked = p.ways.find((w) => picked.includes(w.provider));
    return asked ? [asked] : picked.includes(p.plan) ? [p.ways[0]] : [];
  });

/** A space a computer of theirs is shared into, where others' agents work on it as them. */
export type SharedIn = { _id: string; name: string };

/** One of the person's computers, as the plans need it. */
export type Machine = {
  computer: Computer;
  name: string;
  /** A cloud computer's (a kind's), which wakes when it's asked: its kind's View, its icon. */
  kind?: { view: string; icon?: string };
  /** Where others' agents work on it as its owner (it can't run their plan); `true`: somewhere they don't reach. */
  shared: SharedIn[] | true | false;
};

/** Whether others' agents work on it as its owner, so their plan can't run there. */
export const isShared = (m: Machine): boolean =>
  Array.isArray(m.shared) ? m.shared.length > 0 : m.shared;

/** Whether it can be asked now: online, or one the app keeps (a cloud computer), which wakes. */
export const reachable = (m: Machine) => m.computer.online || !!m.kind;

/** What `computer` last said of `engine`. */
export const seenOf = (computer: Computer, engine: EngineName): EngineSeen | undefined =>
  (computer.engines as Partial<Record<EngineName, EngineSeen>> | undefined)?.[engine];

/** The plan `computer` is signed in to, as it last said, named: it isn't shared with others' agents while it is. */
export function signedPlan(computer: Computer): string | undefined {
  const engine = Object.values(ENGINE_OF).find((e) => seenOf(computer, e)?.signedIn);
  return engine ? titleOf(engine) : undefined;
}

/**
 * The computer the flow readies for a person's CLIs: the one asked for, else
 * the best of theirs not shared with others' agents: online, then one the app
 * keeps (it wakes), then the rest, the most recently seen first. None: they
 * have no computer that can run plans.
 */
export function bestComputer(machines: Machine[], asked?: string): Machine | undefined {
  const usable = machines.filter((m) => !isShared(m));
  const given = usable.find((m) => m.computer._id === asked);
  if (given) return given;
  const tier = (m: Machine) => m.computer.online ? 0 : m.kind ? 1 : 2;
  return [...usable].sort((a, b) =>
    tier(a) - tier(b) || (b.computer.seen ?? "").localeCompare(a.computer.seen ?? "")
  )[0];
}

/** How a plan stands for the person, as its card says it. */
export type Card =
  /** Its agents' calls run on it now: on the server, or on a computer (`on`), with a backup. */
  | {
    state: "ready";
    way: Way;
    account?: Account;
    on?: Machine;
    backup?: Machine;
    /** Another way in, ready too: ChatGPT through Codex, behind ChatGPT on the server. */
    also?: { way: Way; on: Machine };
    /** When it reached its limit there, if it's at it. */
    limited?: string;
  }
  /** Signed in only on computers of theirs that are off. */
  | { state: "away"; way: Way; on: Machine[] }
  /** It needs them: an account to sign in again, or signed in only where others' agents work. */
  | { state: "broken"; way: Way; why: "reconnect"; account: Account }
  | { state: "broken"; way: Way; why: "shared"; on: Machine[] }
  | { state: "off" };

/** The computers a way's plan is signed in on, in the order calls try them (shared ones apart). */
export function servingOn(machines: Machine[], engine: EngineName): Machine[] {
  const usable = machines.filter((m) => !isShared(m));
  return servingOrder(usable.map((m) => m.computer), engine)
    .map((c) => usable.find((m) => m.computer === c)!);
}

/**
 * How `plan` stands for the person, from what's kept (accounts, and what
 * each computer last said): the first of its ways in their order that runs
 * now (with the next computer that could, as its backup), else what needs
 * them, else whether it's signed in only on computers that are off, else
 * not connected.
 */
export function cardOf(plan: PlanShown, machines: Machine[], accounts: Account[]): Card {
  const ready: Extract<Card, { state: "ready" }>[] = [];
  let broken: Card | undefined;
  let away: Card | undefined;
  for (const way of plan.ways) {
    if (way.account) {
      const account = accounts.find((a) => a.provider === way.account);
      if (account?.status === "connected") ready.push({ state: "ready", way, account });
      else if (account) broken ??= { state: "broken", way, why: "reconnect", account };
      continue;
    }
    if (!way.engine) continue;
    const on = servingOn(machines, way.engine);
    const now = on.filter(reachable);
    if (now.length) {
      const limited = seenOf(now[0].computer, way.engine)?.limited;
      ready.push({
        state: "ready",
        way,
        on: now[0],
        ...(now[1] ? { backup: now[1] } : {}),
        ...(limited ? { limited } : {}),
      });
    } else if (on.length) away ??= { state: "away", way, on };
    else {
      const shared = machines.filter((m) =>
        isShared(m) && seenOf(m.computer, way.engine!)?.signedIn
      );
      if (shared.length) broken ??= { state: "broken", way, why: "shared", on: shared };
    }
  }
  const [first, second] = ready;
  if (first) return second?.on ? { ...first, also: { way: second.way, on: second.on } } : first;
  return broken ?? away ?? { state: "off" };
}

/**
 * Where others' agents work on a computer as its owner, from its desks:
 * those in a space other than a Personal one, where agents answer to
 * whoever they work for (see shared/engines.ts).
 */
export function sharedIn(
  desks: Desk[],
  spaces: { _id: string; name: string; kind?: string }[],
): SharedIn[] {
  return desks.flatMap((desk) => {
    if (desk.answers !== "asker") return [];
    const space = spaces.find((s) => s._id === desk.in);
    if (!space || space.kind === "personal") return [];
    return [{ _id: space._id, name: space.name }];
  });
}

/** Names as a sentence lists them: "Acme", "Acme and Design", "Acme, Design and Ops". */
export function listed(names: string[]): string {
  if (names.length < 2) return names.join("");
  if (names.length === 2) return say("listPair", { first: names[0], second: names[1] });
  return say("listMore", { rest: names.slice(0, -1).join(", "), last: names.at(-1)! });
}

/**
 * A CLI's output as it reads on a page: no colours or cursor moves, a line
 * redrawn in place kept as its last state, no runs of blank lines.
 */
export function plainOutput(text: string): string {
  return text
    // OSC (titles, links) and CSI (colours, cursor) sequences, and other escapes.
    // deno-lint-ignore no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // deno-lint-ignore no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // deno-lint-ignore no-control-regex
    .replace(/\x1b[@-_]/g, "")
    .split("\n")
    .map((line) => line.split("\r").filter(Boolean).at(-1) ?? "")
    .join("\n")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

/** A sign-in link, only when it's a web address (never `javascript:` or a file). */
export function safeLink(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A code the CLI shows for the person to type on the sign-in page (a device's
 * sign-in: "enter ABCD-EFGH at …"), when it shows one.
 */
export function shownCode(output: string): string | undefined {
  const said = /\b(?:code|enter)\b[^\n]{0,60}\n?[^\n]{0,40}?\b([A-Z0-9]{3,5}(?:-[A-Z0-9]{3,5})+)\b/
    .exec(output);
  return said?.[1];
}

/** Whether what a CLI said asks for a code to be pasted back to it (not one it shows). */
export const asksForCode = (output: string): boolean =>
  !shownCode(output) &&
  /\b(paste|enter|input)\b[^\n]{0,40}\b(code|token)\b|\b(code|token)\b[^\n]{0,20}:\s*$/im.test(
    output,
  );

/** What a sign-in answers each time it's asked (`computer.engine.login`, shared/workloads.ts). */
export type LoginStep = {
  state: "running" | "done";
  output: string;
  signedIn: boolean;
  url?: string;
  /** Done: whether its CLI is there now (not, when its installer failed). */
  installed?: boolean;
};

/** What a sign-in under way says: each answer, or why it couldn't go on. */
export type LoginEvent = { step: LoginStep } | { error: unknown };

/**
 * Signs `engine` in on `computer` (`computer.engine.login`): asks again every
 * `every` ms while it runs, one call at a time, each answer to `on`, until
 * it's done or fails. `install`: its first call has the CLI installed first
 * when it's missing there. `send` hands the CLI what the person typed (on the
 * next call, at once when none is under way); `stop` ends it there too;
 * `leave` stops asking without telling it (it's done, or gone).
 */
export function signingIn(
  { call, computer, engine, on, every = 1000, install = false }: {
    call<R = unknown>(action: string, input?: unknown): Promise<R>;
    computer: string;
    engine: EngineName;
    on(event: LoginEvent): void;
    every?: number;
    install?: boolean;
  },
): { send(text: string): void; stop(): void; leave(): void } {
  let over = false;
  let flying = false;
  let typed: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ask = async () => {
    if (over) return;
    clearTimeout(timer);
    flying = true;
    const input = typed;
    const installing = install;
    typed = undefined;
    install = false;
    try {
      const step = await call<LoginStep>("computer.engine.login", {
        computer,
        engine,
        ...(input !== undefined ? { input } : {}),
        ...(installing ? { install: true } : {}),
      });
      flying = false;
      if (over) return;
      if (step.state === "done") over = true;
      on({ step });
      if (!over) timer = setTimeout(() => void ask(), typed !== undefined ? 0 : every);
    } catch (error) {
      flying = false;
      if (over) return;
      over = true;
      on({ error });
    }
  };
  void ask();
  return {
    send(text) {
      typed = text;
      if (!flying && !over) void ask();
    },
    stop() {
      if (over) return;
      over = true;
      clearTimeout(timer);
      void call("computer.engine.login", { computer, engine, stop: true }).catch(() => {});
    },
    leave() {
      over = true;
      clearTimeout(timer);
    },
  };
}
