/**
 * The chat plugin's contract: what plugins built on chat (memory, history,
 * spaces, computers) may import from it: the shapes of its documents and of
 * the resource kinds it reads (`agents`, `tools`, `context`, `roster`,
 * `agentSources`; on the web, `conversation`, `home`, `toolViews` and
 * `refusals`),
 * `tool()` to declare a tool, and what knowing agents takes (`agentsOf`,
 * `defaults`, `modelOf`, `agentsNamed`, `agentsShown`, `SEND`).
 * Everything else they reach through the runtime: its collections by name
 * (`message`, `thread`…), its queries (`thread.agents`: who answers in a
 * space, and what each agent is), its events (`message.created`,
 * `turn.requested`), its Actions (`chat.send`, `chat.stop`, `chat.move`…).
 */
export type { File } from "./collections/file.ts";
export type { Live, LiveCall } from "./collections/live.ts";
export type { Message } from "./collections/message.ts";
export type { Thread } from "./collections/thread.ts";
export type { Wait } from "./collections/wait.ts";
export type {
  Agent,
  ChatSettings,
  ContextEntry,
  ConversationView,
  HomeView,
  Offer,
  Prompt,
  RefusalView,
  ShownCall,
  Step,
  Tool,
  ToolContext,
  ToolViews,
  Turn,
} from "./shared/types.ts";
export { tool } from "./shared/types.ts";
export { type Origin, originKey, originOf } from "./shared/origin.ts";
export type { AgentSource, Roster, RosterSource, Team } from "./shared/agents.ts";
/**
 * The app's agents (`agentsOf`), who of them answer new conversations
 * (`defaults`), an agent's model (`modelOf`), which names are agents and
 * what each is (`agentsNamed`; inside a View, `agentsShown`), and the name
 * of the tool agents message with (`SEND`).
 */
export { agentsNamed, agentsOf, agentsShown, defaults, modelOf, SEND } from "./shared/agents.ts";
