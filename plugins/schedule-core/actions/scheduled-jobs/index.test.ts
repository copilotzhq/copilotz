import { assertEquals, assertExists } from "@std/assert";
import { scheduledJobsAction } from "./index.ts";

Deno.test("scheduledJobsAction owns its schema and identity", () => {
  assertEquals(
    scheduledJobsAction.id,
    "copilotz.core-schedules.scheduled-jobs",
  );
  assertExists(scheduledJobsAction.inputSchema);
  const schema = scheduledJobsAction.inputSchema as {
    properties: {
      run: {
        properties: Record<string, unknown>;
      };
    };
  };
  assertEquals(
    Object.keys(schema.properties.run.properties).includes(
      "recipients",
    ),
    true,
  );
  assertEquals(
    Object.keys(schema.properties.run.properties).includes(
      "recipientIds",
    ),
    false,
  );
});
