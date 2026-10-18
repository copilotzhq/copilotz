/** Explicit provisioning for Core's chronological Message access path. @module */
import {
  provisionNodeIndex,
  type SqlSession,
  validateCopilotzSchema,
  validateEventSchemaName,
} from "@copilotz/copilotz/events";

/** Installs and validates the history index during owner-controlled provisioning. */
export async function provisionCoreHistoryIndexes(
  session: SqlSession,
  schemaName = "public",
): Promise<void> {
  const schema = validateEventSchemaName(schemaName);
  await validateCopilotzSchema(session, schema);
  await provisionNodeIndex(session, schema, {
    name: "core_message_thread_created_idx",
    fields: ["namespace", "type", { data: "threadId" }, "created_at", "id"],
  });
}
