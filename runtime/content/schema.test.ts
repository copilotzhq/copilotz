import { decodeContent, decodeGeneratedContent } from "./codec.ts";
import { assertEquals, assertThrows } from "@std/assert";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import {
  capturePendingContentRef,
  contentRefSchema,
  contentSequenceSchema,
  generatedContentSequenceSchema,
  isContentRef,
  isPendingContentRef,
} from "./schema.ts";

Deno.test("canonical content schema and reference guard validate shared metadata", () => {
  const ref = {
    assetId: "a",
    kind: "text",
    role: "body",
    mediaType: "text/plain",
  };
  for (const kind of contentRefSchema.properties.kind.enum) {
    const value = {
      ...ref,
      kind,
      name: "content",
      disposition: "inline",
      metadata: { source: "test" },
    };
    assertEquals(isContentRef(value), true);
    validateAgainstJsonSchema(contentSequenceSchema, [value], "content");
  }
  for (
    const patch of [
      { assetId: 3 },
      { kind: "unknown" },
      { role: null },
      { mediaType: [] },
      { name: 1 },
      { disposition: "unknown" },
      { metadata: [] },
    ]
  ) {
    const invalid = { ...ref, ...patch };
    assertEquals(isContentRef(invalid), false);
    assertThrows(() =>
      validateAgainstJsonSchema(contentRefSchema, invalid, "content")
    );
  }
  // A reference guard permits resolved entries; the persisted schema does not.
  assertEquals(isContentRef({ ...ref, value: "prepared" }), true);
  assertThrows(() =>
    validateAgainstJsonSchema(
      contentRefSchema,
      { ...ref, value: "prepared" },
      "content",
    )
  );
  assertEquals(isContentRef(null), false);
  assertEquals(isContentRef([]), false);
});

const pending = {
  type: "content.pending" as const,
  pendingRef: "pending-output",
  mediaType: "text/plain",
  byteLength: 3,
  digest: `sha256:${"a".repeat(64)}` as const,
};
Deno.test("generated pending references stay distinct from owned Asset content", () => {
  const captured = capturePendingContentRef(pending);
  assertEquals(captured, pending);
  assertEquals(Object.isFrozen(captured), true);
  assertEquals(isPendingContentRef(pending), true);
  assertEquals(isContentRef(pending), false);
  assertThrows(() => decodeContent(pending));
  assertThrows(() =>
    validateAgainstJsonSchema(contentSequenceSchema, [pending], "content")
  );
  validateAgainstJsonSchema(
    generatedContentSequenceSchema,
    [pending],
    "generated",
  );
  assertEquals(
    decodeGeneratedContent(["inline", pending, {
      assetId: "existing",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
    }]),
    ["inline", pending, {
      assetId: "existing",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
    }],
  );
});
Deno.test("pending references reject physical capabilities and malformed immutable claims", () => {
  for (
    const patch of [
      { assetId: "forged" },
      { location: { key: "physical" } },
      { bodyId: "physical" },
      { writer: {} },
      { pendingRef: "" },
      { pendingRef: " padded " },
      { mediaType: "" },
      { byteLength: -1 },
      { byteLength: -0 },
      { byteLength: Number.MAX_SAFE_INTEGER + 1 },
      { digest: "sha256:short" },
      { digest: `sha256:${"A".repeat(64)}` },
    ]
  ) {
    const value = { ...pending, ...patch };
    assertEquals(isPendingContentRef(value), false);
    assertThrows(() => decodeGeneratedContent(value));
  }
});
Deno.test("generated pointer decoding does not execute accessors or accept exotic objects", () => {
  let reads = 0;
  const accessor = {
    ...pending,
    get pendingRef() {
      reads++;
      return "forged";
    },
  };
  assertEquals(isPendingContentRef(accessor), false);
  assertThrows(() => decodeGeneratedContent(accessor));
  const array = [pending];
  Object.defineProperty(array, "0", {
    enumerable: true,
    get() {
      reads++;
      return pending;
    },
  });
  assertThrows(() => decodeGeneratedContent(array));
  assertEquals(reads, 0);
  assertEquals(
    isPendingContentRef(Object.assign(Object.create({}), pending)),
    false,
  );
  assertEquals(
    isPendingContentRef({ ...pending, [Symbol("hidden")]: true }),
    false,
  );
});

Deno.test("pending capture and generated sequence never dispatch caller property reads or array methods", () => {
  let gets = 0;
  const proxy = new Proxy(pending, {
    get() {
      gets++;
      return "forged";
    },
  });
  assertEquals(capturePendingContentRef(proxy), pending);
  assertEquals(gets, 0);
  let maps = 0;
  class HostileSequence extends Array<unknown> {
    override map(): never {
      maps++;
      throw new Error("caller map executed");
    }
  }
  const sequence = new HostileSequence(pending);
  assertEquals(decodeGeneratedContent(sequence), [pending]);
  assertEquals(maps, 0);
  assertEquals(
    Object.getPrototypeOf(decodeGeneratedContent(sequence)),
    Array.prototype,
  );
});
