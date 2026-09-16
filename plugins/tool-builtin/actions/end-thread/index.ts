import type { ActionContext } from "@copilotz/copilotz/actions";
import type { ActionDefinition } from "@copilotz/copilotz/actions";
/** Built-in Action that archives the current thread.
 *
 * @module
 */
import { defineAction } from "@copilotz/copilotz/actions";
import { record, requiredText } from "../../shared/input.ts";
import { metadataText } from "../../shared/participants.ts";
export const endThreadAction: ActionDefinition<unknown, {
  threadId: string;
  summary: string;
  status: string;
}, ActionContext> = defineAction({
  id: "copilotz.tools.builtin.end_thread",
  inputSchema: {
    type: "object",
    properties: { summary: { type: "string", minLength: 1 } },
    required: ["summary"],
  },
  async execute(raw, context) {
    const summary = requiredText(record(raw).summary, "summary");
    const threadId = requiredText(
      metadataText(context, "threadId"),
      "Thread ID",
    );
    const thread = await context.collections.thread.get({ id: threadId });
    if (!thread) {
      throw new Error("The active thread was not found.");
    }
    await context.collections.thread.update({
      id: thread.id,
      set: {
        status: "archived",
        metadata: { ...record(thread.metadata), summary },
      },
    }, {
      operationKey: `end_thread:${context.action.runId}`,
      metadata: {
        core: {
          threadId: thread.id,
        },
      },
    });
    return { threadId: thread.id, summary, status: "archived" };
  },
});
