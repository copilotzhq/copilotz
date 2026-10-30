/**
 * The team plugin's contract: the shape of an agent people made. The rest
 * is reached by name: its collection `agent`, its queries (`agent.known`,
 * `agent.options`), its Actions (`agent.create`, `agent.update`,
 * `agent.delete`, `agent.draft`).
 */
export type { AgentDoc } from "./collections/agent.ts";
