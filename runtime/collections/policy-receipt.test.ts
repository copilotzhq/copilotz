import { assertEquals } from "@std/assert";
import { encodeCapability } from "../execution/owner-capability-wire.ts";
import { defineCollection } from "./definition.ts";
import { canRecoverCollectionReceipt } from "./policy-receipt.ts";
import { validateCollectionPolicies } from "./policy-registration.ts";
Deno.test("parentless receipt recovery cannot release protected operations without their original invocation", () => {
  const entry = defineCollection({
    name: "protectedEntry",
    ownerPolicy: "required",
    schema: { type: "object" },
  });
  const publicEntry = defineCollection({
    name: "publicEntry",
    schema: { type: "object" },
  });
  const definitions = { entry, publicEntry };
  const policies = validateCollectionPolicies(
    { entry: { authorize() {} } },
    definitions,
  );
  const intent = (path: readonly string[], input: unknown = { id: "one" }) =>
    JSON.parse(
      new TextDecoder().decode(
        encodeCapability({
          plan: [{ path, args: [input] }],
          options: { operationKey: "fixed" },
        }),
      ),
    );
  assertEquals(
    canRecoverCollectionReceipt(
      intent(["collections", "entry", "update"]),
      definitions,
      policies,
    ),
    false,
  );
  assertEquals(
    canRecoverCollectionReceipt(
      intent(["collections", "publicEntry", "create"]),
      definitions,
      policies,
    ),
    true,
  );
  assertEquals(
    canRecoverCollectionReceipt(
      intent(["collections", "hidden", "create"]),
      definitions,
      policies,
    ),
    false,
  );
  assertEquals(
    canRecoverCollectionReceipt(
      intent(["vectors", "upsert"], {
        owner: { type: "protectedEntry", id: "one" },
      }),
      definitions,
      policies,
    ),
    false,
  );
  assertEquals(
    canRecoverCollectionReceipt(
      intent(["relations", "upsert"], {
        source: { type: "publicEntry", id: "one" },
        target: { type: "protectedEntry", id: "two" },
      }),
      definitions,
      policies,
    ),
    false,
  );
  assertEquals(
    canRecoverCollectionReceipt({ plan: [] }, definitions, policies),
    false,
  );
});
