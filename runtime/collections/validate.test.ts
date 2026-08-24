import { assert, assertRejects } from "@std/assert";
import { isNonRetryableError } from "../failure.ts";
import { validateAgainstJsonSchema } from "./validate.ts";

Deno.test("Collection schema validation preserves TypeError and marks it non-retryable", async () => {
  const error = await assertRejects(() =>
    Promise.resolve().then(() =>
      validateAgainstJsonSchema(
        {
          type: "object",
          additionalProperties: false,
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        { id: "record-a", unexpected: true },
        "record create",
      )
    )
  );

  assert(error instanceof TypeError);
  assert(isNonRetryableError(error));
});
