import { assertEquals, assertThrows } from "@std/assert";
import { mergePipelineArguments, serializePipelineValue } from "./pipeline.ts";

Deno.test("mergePipelineArguments deep merges with explicit values winning", () => {
  const piped = {
    customer: { id: "123", status: "new" },
    tags: ["imported"],
  };
  const explicit = {
    customer: { status: "priority" },
    tags: ["manual"],
    notify: true,
  };

  assertEquals(mergePipelineArguments(piped, explicit), {
    customer: { id: "123", status: "priority" },
    tags: ["manual"],
    notify: true,
  });
  assertEquals(piped.customer.status, "new");
});

Deno.test("mergePipelineArguments requires an object pipeline output", () => {
  assertThrows(
    () => mergePipelineArguments("text", { mode: "brief" }),
    Error,
    "Add a jq stage",
  );
});

Deno.test("pipeline JSON normalization rejects unsafe values", () => {
  assertThrows(
    () => serializePipelineValue({ value: Number.NaN }),
    Error,
    "NaN",
  );
  assertThrows(
    () => serializePipelineValue(JSON.parse('{"__proto__":{"polluted":true}}')),
    Error,
    "not allowed",
  );
});
