/**
 * Agents people make, beside those the app declares (chat's `agents`
 * resource): a name to call it by (`_id`, as `@maya`), what it's shown as,
 * what it does, its instructions, model and tools. It belongs where it was
 * made (`in`, a space with the access plugin): who manage that space change
 * it; others meet it where it works.
 *
 * The org's team: one that belongs to the org itself (`in: "*"`) is the
 * org's own, its owners and admins change it, and it works in every space;
 * one with the name of one of the app's agents is the org's version of it
 * (what the org changed of it), and `off` there, the org took it off its
 * team. One the org made can work `like` one of the app's agents: it takes
 * that one's model, where the app chooses models (tiers).
 *
 * Its queries:
 *
 * - `known`: every agent the asker has met, to add one where they work:
 *   the app's, and those people made that belong to or work in a space
 *   they reach (the rules say);
 * - `options`: what an agent can be made with: the app's tools and models;
 * - `team`: the org's team, for its page: the app's agents (as the org has
 *   them: as they are, changed, or taken off), then the org's own.
 */
import { defineCollection, type Infer, people } from "copilotz";
import { type Agent, agentsOf, defaults, SEND, type Tool } from "copilotz/plugins/agents/contract";
import { definitionOf } from "../shared/definition.ts";
import { ORG } from "copilotz/plugins/access/contract";

const agentSchema = {
  type: "object",
  properties: {
    /** What it's shown as ("Maya"); its `_id` is what it's called by. */
    name: { type: "string" },
    /** What it does, for people and for other agents deciding whom to message. */
    description: { type: "string" },
    instructions: { type: "string" },
    /** `"provider/model"` or an alias (see the models plugin). */
    model: { type: "string" },
    effort: { type: "string" },
    /** Names of `tools` resources it may call, and `send_message` to talk to others. */
    tools: { type: "array", items: { type: "string" } },
    /** An emoji it's shown with. */
    icon: { type: "string" },
    /** Where it was made: who manage that space change it; `*`, the org's own. */
    in: { type: "string" },
    /** One of the app's the org took off its team (on the org's version of it). */
    off: { type: "boolean" },
    /** One of the app's agents whose model it takes, where the app chooses models. */
    like: { type: "string" },
    /** Who made it: `person:ana`. */
    by: { type: "string" },
    at: { type: "string" },
  },
  // The org's version of one of the app's has no model of its own: the app's (and its tiers) choose.
  required: ["name", "instructions", "at"],
} as const;

export const agent = defineCollection({
  schema: agentSchema,
  queries: {
    known: {
      allow: people,
      run: async (agents, _, ctx) => {
        const known: Record<string, Agent> = { ...agentsOf(ctx) };
        for (const doc of await agents.find({}, { sort: { name: 1 } })) {
          known[doc._id] = definitionOf(doc as AgentDoc);
        }
        return known;
      },
    },
    team: {
      allow: people,
      run: async (agents, _, ctx) => {
        const declared = agentsOf(ctx);
        const kept = await agents.find({ in: ORG }) as AgentDoc[];
        const mine = new Map(kept.map((doc) => [doc._id, doc]));
        const app = defaults(declared).map((name): TeamAgent => {
          const doc = mine.get(name);
          const shown = doc
            ? { ...declared[name], ...definitionOf(doc, declared[name]) }
            : declared[name];
          return {
            id: name,
            name: shown.name ?? name[0].toUpperCase() + name.slice(1),
            ...(shown.icon ? { icon: shown.icon } : {}),
            ...(shown.description ? { description: shown.description } : {}),
            kind: doc ? "changed" : "app",
            ...(doc?.off ? { off: true as const } : {}),
          };
        });
        const own = kept.filter((doc) => !declared[doc._id])
          .sort((a, b) => a.at.localeCompare(b.at) || a._id.localeCompare(b._id))
          .map((doc): TeamAgent => ({
            id: doc._id,
            name: doc.name,
            ...(doc.icon ? { icon: doc.icon } : {}),
            ...(doc.description ? { description: doc.description } : {}),
            kind: "org",
            ...(doc.like ? { like: doc.like } : {}),
            ...(doc.model ? { model: doc.model } : {}),
          }));
        return { agents: [...app, ...own] };
      },
    },
    options: {
      allow: people,
      run: async (_, __, ctx) => {
        const tools = (ctx.resources.tools ?? {}) as Record<string, Tool>;
        const declared = Object.values(
          (ctx.resources.agents ?? {}) as Record<string, { model: unknown }>,
        );
        const named = [
          ...new Set([
            ...declared.map((a) => a.model).filter((m): m is string => typeof m === "string"),
            ...Object.keys(ctx.resources.model ?? {}),
          ]),
        ];
        // Only those an agent can talk with (not a transcriber, an embedder).
        const models = (await Promise.all(
          named.map((model) =>
            ctx.call("models.check", { model, port: "llm" }).then(() => model, () => undefined)
          ),
        )).filter((model): model is string => model !== undefined);
        return {
          tools: [
            ...Object.entries(tools).map(([name, t]) => ({ name, description: t.description })),
            { name: SEND, description: "Message other agents and people, and wait for replies" },
          ],
          models,
        };
      },
    },
  },
});

export type AgentDoc = Infer<typeof agentSchema> & { _id: string };

/**
 * An agent of the org's team, as its page shows it: one of the app's as it is
 * (`app`) or as the org changed it (`changed`, `off` when it took it off its
 * team), or one the org made (`org`), with the app's agent it works `like` or
 * its own `model`.
 */
export type TeamAgent = {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  kind: "app" | "changed" | "org";
  off?: true;
  like?: string;
  model?: string;
};
