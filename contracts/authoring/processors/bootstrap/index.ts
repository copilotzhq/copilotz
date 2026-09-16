import type { ActionCallers } from "@copilotz/copilotz/actions";
import { coreActions } from "@copilotz/copilotz/core";
import {
  defineProcessor,
  type ProcessorContext,
} from "@copilotz/copilotz/plugins";
type Context = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  ActionCallers<typeof coreActions>
>;
export default defineProcessor<Context>({
  id: "example.bootstrap",
  on: [{ eventType: "example.started" }],
  async handle(_event, context) {
    await context.actions.createThread({
      id: "demo-thread",
      participants: [
        { id: "demo-user", externalId: "demo-user", participantType: "human" },
        {
          id: "demo-agent",
          externalId: "support",
          participantType: "agent",
          agentId: "support",
        },
      ],
    }, { operationKey: "bootstrap" });
  },
});
