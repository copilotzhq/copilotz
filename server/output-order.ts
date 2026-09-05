/** Identifies the Action runs whose bytes must precede a canonical output. */
export function outputActionRuns(output: unknown): readonly string[] {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? value as Record<string, unknown> : {};
  const event = record(output);
  const data = record(event.data);
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value) ids.add(value);
  };
  add(data.actionRunId);
  for (
    const metadata of [
      record(event.metadata),
      record(record(data.record).metadata),
    ]
  ) {
    add(record(metadata.copilotzWorkflow).llmAttemptId);
    add(record(metadata.copilotzToolAction).actionRunId);
    add(
      record(record(metadata.copilotzToolPlanResult).sourceAction).actionRunId,
    );
  }
  return [...ids];
}
