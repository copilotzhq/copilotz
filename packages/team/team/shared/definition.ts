/**
 * An agent someone made, as chat uses it (and shows it: its name and emoji,
 * where it belongs). The org's version of one of the app's (`base`, the
 * app's) says only what the org changed, over the app's: no model of its own,
 * so the app's, and its tiers, choose it.
 */
import type { Effort } from "copilotz/plugins/models/contract";
import type { Agent } from "copilotz/plugins/agents/contract";
import type { AgentDoc } from "../collections/agent.ts";

export const definitionOf = (doc: AgentDoc, base?: Agent): Agent =>
  ({
    instructions: doc.instructions,
    ...(base ? {} : { model: doc.model ?? "" }),
    ...(doc.effort && !base ? { effort: doc.effort as Effort } : {}),
    ...(doc.tools ? { tools: doc.tools } : {}),
    ...(doc.description ? { description: doc.description } : {}),
    ...(doc.name !== doc._id || base ? { name: doc.name } : {}),
    ...(doc.icon ? { icon: doc.icon } : {}),
    ...(doc.in ? { in: doc.in } : {}),
    ...(doc.like ? { like: doc.like } : {}),
  }) as Agent;
