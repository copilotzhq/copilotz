import type { ActionContext } from "@copilotz/copilotz/authoring";
export const runInput = {
  type: "object",
  properties: { runId: { type: "string", pattern: "^[a-zA-Z0-9-]{1,80}$" } },
  required: ["runId"],
  additionalProperties: false,
} as const;
export async function requirePlan(context: ActionContext, runId: string) {
  const row = await context.collections.plan.get({ id: runId });
  if (!row) throw new Error("The coordinator must save the draft first.");
  return row;
}
