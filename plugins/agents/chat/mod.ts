/**
 * Chat: threads where people and agents talk. Agents reply with an LLM and
 * tools; with the `send_message` tool they also message each other and
 * people, in the thread, in a subthread or in a new thread.
 *
 * How a conversation moves:
 * - A message addressed to agents records one `turn.requested` per agent, in
 *   the message's own commit. Turns run keyed by thread and agent, so
 *   different agents work in parallel and each agent's turns stay in order.
 * - An agent's final answer goes back to whoever addressed it, as a reply.
 * - An agent that sent messages expecting replies stops, leaving a `wait`
 *   document. Each reply checks itself off; the last one resumes the agent
 *   with every reply in its history. Waiting holds nothing open.
 * - People are reached the same way: a question to a person waits until they
 *   reply to it.
 * - What an agent is writing shows as it comes: a `live` document per running
 *   turn, kept in memory, swapped for the step or reply it became in one commit.
 * - A person moves a conversation to another space (`chat.move`), with
 *   everything in it; not while an agent is writing in it.
 * - Threads record where they came from (`parent`). A fork (a subthread) sees
 *   its parent's conversation up to the message it started at, through every
 *   level, without copying it; a new thread starts from its first message.
 *
 * - Agents are the app's (its `agents` resource). Two optional hooks widen
 *   that, each an unrecorded Action called as the asker, and cost nothing
 *   when absent: `agentSources` say what agents beyond the app's are (the
 *   team plugin's, agents people make), and the `roster` says who answers
 *   in a space (the spaces plugin's): new conversations there go to its
 *   default, and only its agents are mentioned or messaged there. Without
 *   a roster, every agent answers everywhere. `thread.agents` answers both
 *   for front ends.
 *
 * Declares resource kinds the app (or another plugin) fills in, plain objects:
 * - `agents`: { instructions, model, effort?, maxTokens?, temperature?,
 *   tools?, description?, default?, name?, icon? }, where `model` is
 *   `"provider/model"`, an alias, or a list tried in order (see the models plugin);
 * - `tools`:  { description, input?, run(input) };
 * - `agentSources`: { action }: `{ names }` in, the definitions of those the asker meets out;
 * - `roster`: { action }: `{ space }` in, `{ agents, default? }` out.
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { forkAction } from "./actions/fork.ts";
import { moveAction } from "./actions/move.ts";
import { sendAction } from "./actions/send.ts";
import { stopAction } from "./actions/stop.ts";
import { file } from "./collections/file.ts";
import { live } from "./collections/live.ts";
import { message } from "./collections/message.ts";
import { thread } from "./collections/thread.ts";
import { wait } from "./collections/wait.ts";
import { turnRequested } from "./events/turn-requested.ts";
import { failedProcessor } from "./processors/failed.ts";
import { turnProcessor } from "./processors/turn.ts";
import { agentsOf, modelOf } from "./shared/agents.ts";
import { contextView } from "./views/context.ts";
import { historyView } from "./views/history.ts";
import { messageView } from "./views/message.ts";
import { participants } from "./views/participants.ts";
import { prompt } from "./views/prompt.ts";

export * from "./contract.ts";
export { lineage } from "./shared/lineage.ts";

export const chat: Plugin = definePlugin({
  name: "chat",
  requires: ["models"],
  collections: { thread, message, wait, live, file },
  views: {
    thread: { llm: prompt },
    participants: { llm: participants },
    context: { llm: contextView },
    history: { llm: historyView },
    message: { llm: messageView },
  },
  // Every agent's model can be called as configured (the models plugin says).
  async check(merged) {
    for (const [name, agent] of Object.entries(agentsOf(merged))) {
      if (agent.model === undefined) throw new Error(`Agent "${name}" has no model`);
      try {
        await merged.call("models.check", { model: modelOf(agent), port: "llm" });
      } catch (error) {
        throw new Error(`Agent "${name}": ${(error as Error).message}`);
      }
    }
  },
  actions: {
    "chat.send": sendAction,
    "chat.fork": forkAction,
    "chat.stop": stopAction,
    "chat.move": moveAction,
  },
  events: { "turn.requested": turnRequested },
  processors: {
    "chat.turn": turnProcessor,
    "chat.failed": failedProcessor,
  },
});

export default chat;
