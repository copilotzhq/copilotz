import { defineProcessor } from "@copilotz/copilotz/authoring";
import { assertBrowserWorker } from "../../shared/browser.ts";
const facts = [
  "demo.plan.saveDraft.completed",
  "demo.plan.read.completed",
  "demo.plan.review.completed",
  "demo.plan.publish.completed",
  "copilotz.tools.builtin.get_current_time.completed",
  "copilotz.core.ask.completed",
  "llm.call.completed",
];
export default defineProcessor({
  id: "demo.recordEvidence",
  on: facts.map((eventType) => ({ eventType })),
  async handle(event, context) {
    assertBrowserWorker();
    if (!event.durable) return;
    const data = event.data as {
      output?: { runId?: string; model?: string };
      metadata?: { agentId?: string };
    };
    const result = data.output ?? {};
    const correlationRun = /^demo-run:([a-zA-Z0-9-]{1,80})$/.exec(
      event.correlationId,
    )?.[1];
    if (result.runId && correlationRun && result.runId !== correlationRun) {
      throw new Error("Demo output run does not match its source correlation.");
    }
    const agent = data.metadata?.agentId === "reviewer" ||
        result.model === "reviewer-script"
      ? "reviewer"
      : data.metadata?.agentId === "coordinator" ||
          result.model === "coordinator-script"
      ? "coordinator"
      : "unattributed";
    await context.collections.evidence.create({
      id: event.id,
      sourceId: event.id,
      fact: event.type,
      agent,
      runId: correlationRun ?? result.runId ?? "unattributed",
      correlationId: event.correlationId,
      causationId: event.causationId ?? "",
      at: event.createdAt,
      execution: "browser-worker",
    }, { operationKey: `evidence:${event.id}` });
  },
});
