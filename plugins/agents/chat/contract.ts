/**
 * The chat plugin's contract: what plugins built on chat (memory, history,
 * spaces, computers) may import from it: the shapes of its documents and of
 * the resource kinds it reads (`agents`, `tools`, `context`, `additions`,
 * `roster`, `agentSources`, `agentModel`, `contactSend`; on the web,
 * `conversation`, `home`, `toolViews`, `refusals` and `composerNotes`),
 * `tool()` to declare a tool, its runner (`runTool`, `toolText`: how a turn
 * runs one, for interfaces that run them for a model outside), and what
 * knowing agents takes (`agentsOf`, `defaults`, `modelOf`, `agentsNamed`,
 * `agentsShown`, `SEND`).
 * Everything else they reach through the runtime: its collections by name
 * (`message`, `thread`…), its queries (`thread.agents`: who answers in a
 * space, and what each agent is), its events (`message.created`,
 * `turn.requested`), its Actions (`chat.send`, `chat.stop`, `chat.move`…).
 */
export type { File, FileAbout } from "./collections/file.ts";
export { FILE_CHARS, textual } from "./collections/file.ts";
export type { Live, LiveCall } from "./collections/live.ts";
export { isAnswer, type Message } from "./collections/message.ts";
export type { AdditionShown } from "./collections/shown.ts";
export type { Thread } from "./collections/thread.ts";
export type { Wait } from "./collections/wait.ts";
export type {
  Addition,
  AdditionEntry,
  Agent,
  ChatSettings,
  ComposerNote,
  ContextEntry,
  ConversationView,
  HomeView,
  Offer,
  Prompt,
  RefusalView,
  ShownCall,
  Step,
  Tool,
  ToolAnnotations,
  ToolContext,
  ToolViews,
  Turn,
} from "./shared/types.ts";
export { tool } from "./shared/types.ts";
/**
 * Chat's tool runner, for whoever else runs the app's tools (a model
 * outside, over MCP): a tool's input checked, run, and its result read as
 * agents read it, exactly as a turn does (`runTool`, `toolText`).
 */
export { runTool, type ToolAt, type ToolRun, toolText } from "./shared/tools.ts";
export { type Origin, originKey, originOf } from "./shared/origin.ts";
export type { AgentModel, AgentSource, Roster, RosterSource, Team } from "./shared/agents.ts";
export { CONTACT_TEXT, type ContactSend, MEDIA_TYPE, MEDIA_TYPE_LENGTH } from "./actions/send.ts";
/**
 * The app's agents (`agentsOf`), who of them answer new conversations
 * (`defaults`), an agent's model (`modelOf`), which names are agents and
 * what each is (`agentsNamed`; inside a View, `agentsShown`), and the name
 * of the tool agents message with (`SEND`).
 */
export { agentsNamed, agentsOf, agentsShown, defaults, modelOf, SEND } from "./shared/agents.ts";
