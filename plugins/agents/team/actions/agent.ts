/**
 * Agents people make: `agent.create` makes one where they say (`in`), named
 * after what it's shown as (`Maya` is called `maya`; `maya-2` when that's
 * taken), from the app's tools and models, or from one the app declares
 * (`from`, to start from what it is); `agent.update` changes it,
 * `agent.delete` removes it; `agent.draft` writes instructions from what
 * it should do, for a person to read before making it. Who may make or
 * change one where it belongs is the rules' business (with the access
 * plugin: those who manage that space).
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import type { Completion } from "../../../models/contract.ts";
import { agentsOf, defaults, modelOf, SEND, type Tool } from "../../chat/contract.ts";
import type { AgentDoc } from "../collections/agent.ts";

const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid" });
const forbidden = (agent: string) =>
  Object.assign(new Error(`Only those who manage where "${agent}" belongs change it.`), {
    code: "forbidden",
  });

const fields = {
  name: { type: "string", minLength: 1, maxLength: 60 },
  description: { type: "string", maxLength: 500 },
  instructions: { type: "string", maxLength: 20_000 },
  model: { type: "string", minLength: 1 },
  effort: { type: "string" },
  tools: { type: "array", items: { type: "string" }, maxItems: 64 },
  icon: { type: "string", maxLength: 16 },
} as const;

type Fields = {
  name?: string;
  description?: string;
  instructions?: string;
  model?: string;
  effort?: string;
  tools?: string[];
  icon?: string;
};

/** The model agents are made with unless someone says: the app's first default agent's. */
function usualModel(ctx: Pick<Context, "resources">): string | undefined {
  const declared = agentsOf(ctx);
  const model = declared[defaults(declared)[0]]?.model;
  return typeof model === "string" ? model : undefined;
}

/** Throws unless every tool is the app's (or `send_message`) and the model can be called. */
async function checked(ctx: Context, given: Fields) {
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
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input: Fields & { in?: string; from?: string; name: string }) => {
    const base = input.from ? agentsOf(ctx)[input.from] : undefined;
    if (input.from && !base) throw invalid(`No agent "${input.from}" to start from.`);
    const model = input.model ??
      (typeof base?.model === "string" ? base.model : undefined) ?? usualModel(ctx);
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
      by: `${ctx.actor!.kind}:${ctx.actor!.id}`,
      at: new Date().toISOString(),
    });
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
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input: Fields & { agent: string }) => {
    const { agent, ...given } = input;
    const found = await ctx.db.collection<AgentDoc>("agent").findOne({ _id: agent });
    if (!found) throw invalid(`No agent "${agent}" to change.`);
    await checked(ctx, { ...given, effort: given.effort ?? found.effort });
    const cleared = (["description", "icon", "effort"] as const).filter((f) => given[f] === "");
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
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const known = await ctx.db.collection("agent").findOne({ _id: input.agent });
    if (!known) throw invalid(`No agent "${input.agent}" to remove.`);
    const gone = await ctx.db.collection("agent").deleteOne({ _id: input.agent });
    if (!gone.deletedCount) throw forbidden(input.agent);
    return { deleted: input.agent };
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
  allow: (actor) => actor.kind === "person",
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
