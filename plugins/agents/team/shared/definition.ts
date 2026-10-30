/** An agent someone made, as chat uses it (and shows it: its name and emoji, where it belongs). */
import type { Effort } from "../../../models/contract.ts";
import type { Agent } from "../../chat/contract.ts";
import type { AgentDoc } from "../collections/agent.ts";

export const definitionOf = (doc: AgentDoc): Agent => ({
  instructions: doc.instructions,
  model: doc.model,
  ...(doc.effort ? { effort: doc.effort as Effort } : {}),
  ...(doc.tools ? { tools: doc.tools } : {}),
  ...(doc.description ? { description: doc.description } : {}),
  ...(doc.name !== doc._id ? { name: doc.name } : {}),
  ...(doc.icon ? { icon: doc.icon } : {}),
  ...(doc.in ? { in: doc.in } : {}),
});
