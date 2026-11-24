/**
 * Agents people make: `agent.create` makes one where they say (`in`), named
 * after what it's shown as (`Maya` is called `maya`; `maya-2` when that's
 * taken), from the app's tools and models, or from one the app declares
 * (`from`, to start from what it is); `agent.update` changes it,
 * `agent.delete` removes it; `agent.draft` writes instructions from what
 * it should do, for a person to read before making it. Who may make or
 * change one where it belongs is the rules' business (with the access
 * plugin: those who manage that space).
 *
 * The org's team, by its owners and admins: one made for the org (`in: "*"`)
 * joins every space in use, and new ones as they're made; it can work `like`
 * one of the app's agents (that one's model, where the app chooses). One of
 * the app's agents changed (`agent.update`) is the org's version of it, its
 * model still the app's to choose; deleted (`agent.delete`), it's off the
 * team: it leaves every space and joins no new one. `agent.restore` puts it
 * back, as the org had it; `agent.reset` drops the org's changes, back to
 * the app's, on the team.
 */
import { type Context, defineAction, inPerson, invalid, people } from "copilotz";
import type { Completion, ModelRef } from "copilotz/plugins/models/contract";
import {
  type Agent,
  agentsOf,
  defaults,
  modelOf,
  SEND,
  type Tool,
} from "copilotz/plugins/agents/contract";
import { must, ORG } from "copilotz/plugins/access/contract";
import type { AgentDoc } from "../collections/agent.ts";
import { joinEverywhere, leaveEverywhere } from "../shared/everywhere.ts";
import { checkInstructions } from "../shared/limits.ts";

const forbidden = (agent: string) =>
  Object.assign(new Error(`Only those who manage where "${agent}" belongs change it.`), {
    code: "forbidden",
  });

const fields = {
  name: { type: "string", minLength: 1, maxLength: 60 },
  description: { type: "string", maxLength: 500 },
  // As long as the app lets them be (`team.instructionsLimit`: shared/limits.ts).
  instructions: { type: "string" },
  model: { type: "string", minLength: 1 },
  effort: { type: "string" },
  tools: { type: "array", items: { type: "string" }, maxItems: 64 },
  icon: { type: "string", maxLength: 16 },
  /** One of the app's agents whose model it takes, where the app chooses; "" for its own. */
  like: { type: "string" },
} as const;

type Fields = {
  name?: string;
  description?: string;
  instructions?: string;
  model?: string;
  effort?: string;
  tools?: string[];
  icon?: string;
  like?: string;
};

/** The model a ref tries first, as `"provider/model"` or an alias. */
function firstOf(ref: ModelRef | undefined): string | undefined {
  if (typeof ref === "string") return ref;
  if (Array.isArray(ref)) return firstOf(ref[0]);
  return ref && typeof ref === "object" ? firstOf(ref.model as ModelRef) : undefined;
}

/** The model agents are made with unless someone says: the app's first default agent's. */
function usualModel(ctx: Pick<Context, "resources">): string | undefined {
  const declared = agentsOf(ctx);
  return firstOf(declared[defaults(declared)[0]]?.model);
}

/** A quick model for drafting: the app's `cheap` alias when it has one, else the usual one. */
function draftingModel(ctx: Pick<Context, "resources">): string | undefined {
  return (ctx.resources.model as Record<string, unknown> | undefined)?.cheap !== undefined
    ? "cheap"
    : usualModel(ctx);
}

/** Throws unless the caller runs the org: its team is its owners' and admins'. */
const runsTeam = (ctx: Context) =>
  must(ctx, "manage", ORG, "Only the org's owners and admins change its team.");

/** What one of the app's agents is shown as: its name, else its id with a capital. */
const nameOf = (id: string, agent: Agent) => agent.name ?? id[0].toUpperCase() + id.slice(1);

/** The org's version of one of the app's agents, as it starts: the app's, the org's from now on. */
async function versionOf(
  ctx: Context,
  id: string,
  agent: Agent,
  more: Record<string, unknown> = {},
) {
  await ctx.db.collection("agent").insertOne({
    _id: id,
    name: nameOf(id, agent),
    ...(agent.description ? { description: agent.description } : {}),
    instructions: agent.instructions ?? "",
    ...(agent.icon ? { icon: agent.icon } : {}),
    in: ORG,
    by: `${ctx.actor!.kind}:${ctx.actor!.id}`,
    at: new Date().toISOString(),
    ...more,
  });
}

/** The kind of work it does, by name (the tiers say which there are; an unknown one is the first). */
function likeOf(_ctx: Context, like?: string): string | undefined {
  if (!like) return undefined;
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(like)) throw invalid(`"${like}" isn't a kind of work.`);
  return like;
}

/** Throws unless every tool is the app's (or `send_message`) and the model can be called. */
async function checked(ctx: Context, given: Fields) {
  checkInstructions(ctx.resources, given.instructions);
  const tools = (ctx.resources.tools ?? {}) as Record<string, Tool>;
  const unknown = (given.tools ?? []).filter((name) => name !== SEND && !tools[name]);
  if (unknown.length) throw invalid(`No tool ${unknown.map((t) => `"${t}"`).join(", ")}.`);
  if (given.model) {
    await ctx.call("models.check", {
      model: modelOf({ instructions: "", model: given.model, effort: given.effort as never }),
      port: "llm",
    }).catch((error) => {
      throw invalid((error as Error).message);
    });
  }
}

/** What `name` is called by: lowercase, dashes, unique among agents (`maya`, `maya-2`). */
async function handleFor(ctx: Context, name: string): Promise<string> {
  const base = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "agent";
  const declared = agentsOf(ctx);
  const made = ctx.as().db.collection("agent");
  for (let n = 1;; n++) {
    const handle = n === 1 ? base : `${base}-${n}`;
    if (!declared[handle] && !await made.findOne({ _id: handle })) return handle;
  }
}

export const createAgentAction = defineAction({
  description: "Makes an agent, where you say; it's called by a name made from what it's shown as",
  input: {
    type: "object",
    properties: {
      in: { type: "string" },
      /** One the app declares, to start from what it is. */
      from: { type: "string" },
      ...fields,
    },
    required: ["name"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input: Fields & { in?: string; from?: string; name: string }) => {
    const base = input.from ? agentsOf(ctx)[input.from] : undefined;
    if (input.from && !base) throw invalid(`No agent "${input.from}" to start from.`);
    const like = likeOf(ctx, input.like);
    if (input.in === ORG) await runsTeam(ctx);
    // With tiers, its model is its kind's in the tier in force; this one stands where none applies.
    const model = input.model ?? firstOf(like ? agentsOf(ctx)[like]?.model : undefined) ??
      firstOf(base?.model) ?? usualModel(ctx);
    if (!model) throw invalid("Say which model it uses.");
    const description = input.description ?? base?.description;
    const tools = input.tools ?? base?.tools;
    const effort = input.effort ?? base?.effort;
    await checked(ctx, { ...input, model, tools, effort });
    const agent = await handleFor(ctx, input.name);
    await ctx.db.collection("agent").insertOne({
      _id: agent,
      name: input.name.trim(),
      ...(description ? { description } : {}),
      instructions: input.instructions ?? base?.instructions ??
        `You are ${input.name.trim()}.${description ? ` ${description}` : ""}`,
      model,
      ...(effort ? { effort } : {}),
      ...(tools ? { tools } : {}),
      ...(input.icon ? { icon: input.icon } : {}),
      ...(input.in ? { in: input.in } : {}),
      ...(like ? { like } : {}),
      by: `${ctx.actor!.kind}:${ctx.actor!.id}`,
      at: new Date().toISOString(),
    });
    // The org's own works in every space.
    if (input.in === ORG) await joinEverywhere(ctx, agent);
    return { agent };
  },
});

export const updateAgentAction = defineAction({
  description: "Changes an agent people made: what it's shown as, does, is told, uses",
  input: {
    type: "object",
    properties: { agent: { type: "string" }, ...fields },
    required: ["agent"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input: Fields & { agent: string }) => {
    const { agent, ...given } = input;
    const app = agentsOf(ctx)[agent];
    let found = await ctx.db.collection<AgentDoc>("agent").findOne({ _id: agent });
    if (app) {
      // One of the app's: the org changes its version of it; its model stays the app's to choose.
      if (given.model || given.effort || given.like) {
        throw invalid(`${nameOf(agent, app)}'s model is chosen with the org's tier.`);
      }
      await runsTeam(ctx);
      if (!found) {
        await versionOf(ctx, agent, app);
        found = await ctx.db.collection<AgentDoc>("agent").findOne({ _id: agent });
      }
    }
    if (!found) throw invalid(`No agent "${agent}" to change.`);
    if (given.like) likeOf(ctx, given.like);
    await checked(ctx, { ...given, effort: given.effort ?? found.effort });
    const cleared = (["description", "icon", "effort", "like"] as const).filter((f) =>
      given[f] === ""
    );
    const set = Object.fromEntries(
      Object.entries(given).filter(([field, value]) =>
        value !== undefined && !cleared.includes(field as never)
      ),
    );
    const changed = await ctx.db.collection("agent").updateOne({ _id: agent }, {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(cleared.length ? { $unset: Object.fromEntries(cleared.map((f) => [f, ""])) } : {}),
    });
    if (!changed.matchedCount) throw forbidden(agent);
    return { agent };
  },
});

export const deleteAgentAction = defineAction({
  description: "Removes an agent people made, from everywhere it works",
  input: {
    type: "object",
    properties: { agent: { type: "string" } },
    required: ["agent"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const app = agentsOf(ctx)[input.agent];
    const known = await ctx.db.collection<AgentDoc>("agent").findOne({ _id: input.agent });
    if (app) {
      // One of the app's: off the org's team, as the org had it.
      await runsTeam(ctx);
      if (known) {
        await ctx.db.collection("agent").updateOne({ _id: input.agent }, { $set: { off: true } });
      } else await versionOf(ctx, input.agent, app, { off: true });
      await leaveEverywhere(ctx, input.agent);
      return { off: input.agent };
    }
    if (!known) throw invalid(`No agent "${input.agent}" to remove.`);
    if (known.in === ORG) {
      await runsTeam(ctx);
      await leaveEverywhere(ctx, input.agent);
    }
    const gone = await ctx.db.collection("agent").deleteOne({ _id: input.agent });
    if (!gone.deletedCount) throw forbidden(input.agent);
    return { deleted: input.agent };
  },
});

export const restoreAgentAction = defineAction({
  description: "Puts one of the app's agents the org took off its team back on it",
  input: {
    type: "object",
    properties: { agent: { type: "string" } },
    required: ["agent"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    if (!agentsOf(ctx)[input.agent]) {
      throw invalid(`"${input.agent}" isn't one of the app's agents.`);
    }
    await runsTeam(ctx);
    await ctx.db.collection("agent").updateOne({ _id: input.agent }, { $unset: { off: "" } });
    await joinEverywhere(ctx, input.agent);
    return { agent: input.agent };
  },
});

export const resetAgentAction = defineAction({
  description: "Drops the org's changes to one of the app's agents: back to the app's, on the team",
  input: {
    type: "object",
    properties: { agent: { type: "string" } },
    required: ["agent"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    if (!agentsOf(ctx)[input.agent]) {
      throw invalid(`"${input.agent}" isn't one of the app's agents.`);
    }
    await runsTeam(ctx);
    const known = await ctx.db.collection<AgentDoc>("agent").findOne({ _id: input.agent });
    if (!known) return { agent: input.agent };
    await ctx.db.collection("agent").deleteOne({ _id: input.agent });
    if (known.off) await joinEverywhere(ctx, input.agent);
    return { agent: input.agent };
  },
});

const DRAFT = "You write the instructions an AI agent works by, in a team where people and " +
  "agents talk in conversations. From its name and what it should do, write its instructions " +
  'in the second person ("You are…"): who it is, what it does and doesn\'t, how it works and ' +
  "answers. Plain prose, under 200 words. Reply with the instructions alone.";

export const draftAgentAction = defineAction({
  description: "Writes instructions for an agent from its name and what it should do",
  input: {
    type: "object",
    properties: {
      name: fields.name,
      description: { type: "string", minLength: 1, maxLength: 500 },
      model: fields.model,
    },
    required: ["name", "description"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const model = input.model ?? usualModel(ctx);
    if (!model) throw invalid("Say which model writes it.");
    const { text } = await ctx.call<Completion>("llm.generate", {
      model,
      instructions: DRAFT,
      messages: [{
        role: "user",
        text: `Name: ${input.name}\nWhat it should do: ${input.description}`,
      }],
      tags: { purpose: "agent.draft" },
    });
    return { instructions: text.trim() };
  },
});

const SKETCH = "You design AI agents for a team where people and agents work together in " +
  "conversations. From what a person says an agent should do, call make_agent once with: a " +
  "short first name it's called by (one or two words, a person's name or a plain role, never " +
  "the word 'agent' or 'bot'), one emoji, what it does in one or two plain sentences (for " +
  "people and for other agents deciding whom to ask), its instructions in the second person " +
  '("You are…": who it is, what it does and doesn\'t, how it works and answers; plain prose, ' +
  "under 180 words), and the kind of work closest to it, from the list given. Write in the " +
  "language the person wrote in.";

/**
 * `agent.sketch` `{ asked, kinds? }`: a whole agent drafted from what a person
 * says it should do, for them to read before making it: its name, emoji,
 * what it does, instructions, and of the `kinds` of work given (`{ kind,
 * title, agents? }`), the closest (`like`). One quick model call (the app's
 * `cheap` alias when it has one); nothing is made.
 */
export const sketchAgentAction = defineAction({
  description: "Drafts a whole agent from what it should do",
  input: {
    type: "object",
    properties: {
      asked: { type: "string", minLength: 3, maxLength: 1000 },
      kinds: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            kind: { type: "string" },
            title: { type: "string" },
            agents: { type: "array", items: { type: "string" } },
          },
          required: ["kind", "title"],
        },
      },
    },
    required: ["asked"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const model = draftingModel(ctx);
    if (!model) throw invalid("There's no model to draft it with.");
    const kinds = (input.kinds ?? []) as { kind: string; title: string; agents?: string[] }[];
    const { text, toolCalls } = await ctx.call<Completion>("llm.generate", {
      model,
      instructions: SKETCH,
      messages: [{
        role: "user",
        text: `What it should do: ${input.asked}` +
          (kinds.length
            ? "\n\nKinds of work:\n" +
              kinds.map((k) =>
                `- ${k.kind}: ${k.title}${k.agents?.length ? ` (like ${k.agents.join(", ")})` : ""}`
              ).join("\n")
            : ""),
      }],
      tools: [{
        name: "make_agent",
        description: "The agent, drafted",
        input: {
          type: "object",
          properties: {
            name: { type: "string" },
            icon: { type: "string" },
            description: { type: "string" },
            instructions: { type: "string" },
            ...(kinds.length ? { kind: { type: "string", enum: kinds.map((k) => k.kind) } } : {}),
          },
          required: ["name", "icon", "description", "instructions"],
        },
      }],
      tags: { purpose: "agent.draft" },
    });
    const made = toolCalls.find((c) => c.name === "make_agent")?.input as
      | { name?: string; icon?: string; description?: string; instructions?: string; kind?: string }
      | undefined;
    if (!made?.name || !made.instructions) {
      throw Object.assign(invalid("Couldn't draft it this time: try saying a bit more."), {
        detail: { said: text.slice(0, 200) },
      });
    }
    return {
      name: made.name.trim().slice(0, 60),
      icon: [...(made.icon ?? "").trim()].slice(0, 2).join(""),
      description: (made.description ?? "").trim().slice(0, 500),
      instructions: made.instructions.trim(),
      ...(made.kind && kinds.some((k) => k.kind === made.kind) ? { like: made.kind } : {}),
    };
  },
});
