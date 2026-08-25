import { assert, assertEquals } from "@std/assert";
import { createCopilotz } from "../../index.ts";

const NAMESPACE = "package-root-contract";

Deno.test("root createCopilotz exposes one causal send handle without queue state", async () => {
  const copilotz = await createCopilotz({ namespace: NAMESPACE });
  try {
    assertEquals(Object.keys(copilotz).sort(), ["close", "observe", "send"]);
    const run = await copilotz.send({
      type: "contract.public-input",
      namespace: NAMESPACE,
      payload: { value: "Hello" },
    });
    await run.done;

    assert(run.eventId.length > 0);
    assert(run.correlationId.length > 0);
    assertEquals(Object.keys(run).sort(), [
      "cancel",
      "correlationId",
      "done",
      "eventId",
      "outputs",
    ]);
  } finally {
    await copilotz.close();
  }
});
