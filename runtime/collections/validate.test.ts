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

Deno.test("synchronous schema boundaries refuse async declarations before invocation", async () => {
  const { assertThrows, assertEquals } = await import("@std/assert");
  const {
    validateCollectionRecord,
    validateCollectionInput,
    isJsonSchemaValidationError,
  } = await import("./validate.ts");
  const { isCollectionValidationError } = await import("./errors.ts");
  let rejections = 0;
  const reject = (event: PromiseRejectionEvent) => {
    if ((event.reason as { validation?: boolean })?.validation === true) {
      rejections++;
      event.preventDefault();
    }
  };
  globalThis.addEventListener("unhandledrejection", reject);
  try {
    for (
      const validate of [
        validateAgainstJsonSchema,
        validateCollectionRecord,
        validateCollectionInput,
      ]
    ) {
      for (
        const schema of [{
          $async: true,
          type: "object",
          required: ["missing"],
        }, { $async: true, type: "object" }]
      ) {
        const error = assertThrows(() => validate(schema, {}, "async input"));
        assert(error instanceof TypeError);
        assert(isNonRetryableError(error));
        assert(!isJsonSchemaValidationError(error));
        assert(!isCollectionValidationError(error));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(rejections, 0, "unsupported validators must never run");
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 0));
    globalThis.removeEventListener("unhandledrejection", reject);
  }
});

Deno.test("async declarations cannot be hidden in accessors, inheritance or cached schema changes", async () => {
  const { assertThrows, assertEquals } = await import("@std/assert");
  let reads = 0;
  const accessor = Object.defineProperty({ type: "object" }, "$async", {
    get() {
      reads++;
      return true;
    },
  });
  assertThrows(() => validateAgainstJsonSchema(accessor, {}, "accessor"));
  assertEquals(reads, 0);
  const inherited = Object.assign(Object.create({ $async: true }), {
    type: "object",
  });
  assertThrows(() => validateAgainstJsonSchema(inherited, {}, "inherited"));
  const cached = { $async: false, type: "object" };
  validateAgainstJsonSchema(cached, {}, "sync first");
  cached.$async = true;
  assertThrows(() => validateAgainstJsonSchema(cached, {}, "async later"));
  for (const marker of [null, undefined, "true", 1]) {
    assertThrows(() =>
      validateAgainstJsonSchema(
        { $async: marker, type: "object" },
        {},
        "malformed",
      )
    );
  }
});

Deno.test("nested and referenced async schemas refuse without becoming value mismatches", async () => {
  const { assertThrows } = await import("@std/assert");
  const { validateCollectionInput, isJsonSchemaValidationError } = await import(
    "./validate.ts"
  );
  const { isCollectionValidationError } = await import("./errors.ts");
  for (
    const schema of [
      {
        type: "object",
        properties: { child: { $async: true, type: "string" } },
      },
      {
        definitions: { child: { $async: true, type: "object" } },
        $ref: "#/definitions/child",
      },
    ]
  ) {
    const error = assertThrows(() =>
      validateCollectionInput(schema, {}, "nested async")
    );
    assert(isNonRetryableError(error));
    assert(!isJsonSchemaValidationError(error));
    assert(!isCollectionValidationError(error));
  }
});

Deno.test("synchronous schemas preserve success, nonmutating validation and ordinary error classification", async () => {
  const { assertThrows, assertEquals } = await import("@std/assert");
  const { validateCollectionInput, isJsonSchemaValidationError } = await import(
    "./validate.ts"
  );
  const { isCollectionValidationError } = await import("./errors.ts");
  const schema = {
    $async: false,
    type: "object",
    properties: { count: { type: "number", default: 1 } },
    required: ["count"],
  };
  const value = { count: 3 };
  validateAgainstJsonSchema(schema, value, "sync");
  assertEquals(value, { count: 3 });
  const raw = assertThrows(() => validateAgainstJsonSchema(schema, {}, "sync"));
  assert(isJsonSchemaValidationError(raw));
  assert(!isCollectionValidationError(raw));
  const collection = assertThrows(() =>
    validateCollectionInput(schema, {}, "sync")
  );
  assert(isCollectionValidationError(collection));
  assert(isNonRetryableError(collection));
  assertEquals(value, { count: 3 });
});
