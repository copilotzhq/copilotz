/**
 * Agents people make, beside those the app declares (chat's `agents`
 * resource): a name to call it by (`_id`, as `@maya`), what it's shown as,
 * what it does, its instructions, model and tools. It belongs where it was
 * made (`in`, a space with the access plugin): who manage that space change
 * it; others meet it where it works. Its queries:
 *
 * - `known`: every agent the asker has met, to add one where they work:
 *   the app's, and those people made that belong to or work in a space
 *   they reach (the rules say);
 * - `options`: what an agent can be made with: the app's tools and models.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";
import { type Agent, agentsOf, SEND, type Tool } from "../../chat/contract.ts";
import { definitionOf } from "../shared/definition.ts";

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
    /** Where it was made: who manage that space change it. */
    in: { type: "string" },
    /** Who made it: `person:ana`. */
    by: { type: "string" },
    at: { type: "string" },
  },
  required: ["name", "instructions", "model", "at"],
} as const;

export const agent = defineCollection({
  schema: agentSchema,
  queries: {
    known: {
      allow: (actor) => actor.kind === "person",
      run: async (agents, _, ctx) => {
        const known: Record<string, Agent> = { ...agentsOf(ctx) };
        for (const doc of await agents.find({}, { sort: { name: 1 } })) {
          known[doc._id] = definitionOf(doc as AgentDoc);
        }
        return known;
      },
    },
    options: {
      allow: (actor) => actor.kind === "person",
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
