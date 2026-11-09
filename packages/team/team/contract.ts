/**
 * The team plugin's contract: the shape of an agent people made, and of the
 * hints its model picker takes on the web. The rest is reached by name: its
 * collection `agent`, its queries (`agent.known`, `agent.options`), its
 * Actions (`agent.create`, `agent.update`, `agent.delete`, `agent.draft`),
 * and on the web its View `model.pick` (team-web's): the picker an agent's
 * model is chosen with, for other front ends' pages.
 */
export type { AgentDoc } from "./collections/agent.ts";
export type { ModelPick } from "./views/web/model-pick.tsx";
