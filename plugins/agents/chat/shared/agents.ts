/** Small things every part of chat uses: limits, time, agents and their models, tool checks. */
import {
  type Context,
  type Event,
  type ReadContext,
  validator,
  type ViewContext,
} from "../../../../runtime/mod.ts";
import type { ModelRef } from "../../../models/contract.ts";
import type { Message } from "../collections/message.ts";
import type { Agent, Tool, Turn } from "./types.ts";

/** For writes whose answer isn't needed: a transaction then commits them in one call. */
export const NO_ANSWER = { writeConcern: { w: 0 } } as const;

export const HISTORY = 50;
export const SEND = "send_message";

/** Message order is `at` order, so timestamps never repeat within a process. */
let last = 0;
export const now = () => new Date(last = Math.max(Date.now(), last + 1)).toISOString();

/** The agents the app declares (its `agents` resource). */
export const agentsOf = (ctx: Pick<Context, "resources">) =>
  (ctx.resources.agents ?? {}) as Record<string, Agent>;

/**
 * An `agentSources` resource: an Action saying what agents beyond the app's
 * are (a plugin where people make them), by name: `{ names }` in, the
 * definitions of those the asker meets out. Unrecorded, called as the asker.
 */
export type AgentSource = { action: string };

const sourcesOf = (ctx: Pick<ReadContext, "resources">) =>
  Object.values((ctx.resources.agentSources ?? {}) as Record<string, AgentSource>);

/**
 * Which of `names` are agents, and what each is: the app's, then what the
 * `agentSources` say of the rest. The rest are people. Without sources, it
 * reads nothing.
 */
export async function agentsNamed(
  ctx: Pick<ReadContext, "resources" | "call">,
  names: Iterable<string>,
): Promise<Record<string, Agent>> {
  const declared = agentsOf(ctx);
  const found: Record<string, Agent> = {};
  let rest: string[] = [];
  for (const name of new Set(names)) {
    if (declared[name]) found[name] = declared[name];
    else if (name) rest.push(name);
  }
  for (const source of sourcesOf(ctx)) {
    if (!rest.length) break;
    Object.assign(found, await ctx.call<Record<string, Agent>>(source.action, { names: rest }));
    rest = rest.filter((name) => !found[name]);
  }
  return found;
}

/**
 * `agentsNamed`, inside a View (through `thread.agents`): undefined while it
 * reads. A front end's Views run without the app's `agents` and
 * `agentSources` (the owner's resources), so there it asks about every name.
 */
export function agentsShown(
  ctx: ViewContext,
  names: Iterable<string>,
): Record<string, Agent> | undefined {
  const declared = agentsOf(ctx);
  const found: Record<string, Agent> = {};
  const rest: string[] = [];
  for (const name of new Set(names)) {
    if (declared[name]) found[name] = declared[name];
    else if (name) rest.push(name);
  }
  const front = !Object.keys(declared).length;
  if (!rest.length || (!front && !sourcesOf(ctx).length)) return found;
  const team = ctx.db.collection("thread").query<Team>("agents", { names: rest.sort() });
  return team.value ? { ...found, ...team.value.agents } : undefined;
}

/**
 * Who answers in a space: the agents there (`here`), and who answers its
 * new conversations (`default`). The `roster` resource names an Action that
 * says (the spaces plugin's, from its members), called as the asker.
 * Without one, or without a space, every agent answers everywhere (`open`):
 * `here` is the app's, and new conversations go to its defaults; it reads
 * nothing.
 */
export type Roster = { here: string[]; default: string[]; open?: true };

/** A `roster` resource: the Action saying who answers in a space, `{ space }` in, `{ agents, default? }` out. */
export type RosterSource = { action: string };

/** A roster, with what each agent in it (and any other name asked about) is: `thread.agents`. */
export type Team = Roster & { agents: Record<string, Agent> };

export async function rosterOf(
  ctx: Pick<ReadContext, "resources" | "call">,
  space?: string,
): Promise<Roster> {
  const [source] = Object.values((ctx.resources.roster ?? {}) as Record<string, RosterSource>);
  if (source && space) {
    const said = await ctx.call<{ agents: string[]; default?: string }>(source.action, { space });
    return { here: said.agents, default: said.default ? [said.default] : [] };
  }
  const declared = agentsOf(ctx);
  return { here: Object.keys(declared), default: defaults(declared), open: true };
}

/** The roster of `space`, with what each agent there and each of `names` is. */
export async function teamOf(
  ctx: Pick<ReadContext, "resources" | "call">,
  space?: string,
  names: string[] = [],
): Promise<Team> {
  const roster = await rosterOf(ctx, space);
  const agents = await agentsNamed(ctx, [...roster.here, ...names]);
  return { ...roster, here: roster.here.filter((name) => agents[name]), agents };
}

/** An agent's model, with the settings it calls it with. */
export const modelOf = ({ model, effort, maxTokens, temperature }: Agent): ModelRef => ({
  model,
  ...(effort !== undefined ? { effort } : {}),
  ...(maxTokens !== undefined ? { maxTokens } : {}),
  ...(temperature !== undefined ? { temperature } : {}),
});

/** Who a new conversation's messages go to when nobody is mentioned. */
export const defaults = (agents: Record<string, Agent>) => {
  const chosen = Object.keys(agents).filter((name) => agents[name].default);
  return chosen.length ? chosen : Object.keys(agents).slice(0, 1);
};

/** `@name` mentions, in order, once each. */
export const mentions = (text: string) => [
  ...new Set([...text.matchAll(/(?:^|\s)@([\w.-]*\w)/g)].map((m) => m[1])),
];

export const turnOf = (event: Pick<Event, "type" | "data">): Turn =>
  (event.type === "wait.updated" ? event.data.doc : event.data) as Turn;

/** The people in what an agent sees: whoever isn't an agent. */
export const peopleIn = (history: Message[], agents: Record<string, Agent>) => [
  ...new Set(history.flatMap((m) => [m.from, ...m.to]).filter((name) => !agents[name])),
];

/** Each tool's input check, made once: a model's call is checked before it runs. */
const checks = new WeakMap<Tool, (input: unknown) => void>();
export const check = (name: string, tool: Tool) => {
  if (!checks.has(tool)) {
    checks.set(tool, validator(tool.input ?? { type: "object" }, `${name} input`));
  }
  return checks.get(tool)!;
};
