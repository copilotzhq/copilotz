import { assertEquals } from "@std/assert";
import {
  canonicalizeContentRefs,
  cloneContentRef,
  type ContentBodyCandidate,
  materializeContentInput,
} from "./input.ts";
import type { ContentRef } from "./types.ts";

Deno.test("content ref cloning retains only canonical persisted fields", () => {
  const source = {
    assetId: "asset-a",
    kind: "text" as const,
    role: "body",
    mediaType: "text/plain",
    name: "note.txt",
    metadata: { source: "caller" },
    value: "hydrated body",
    resolve: false,
    extra: "not durable",
  };
  const cloned = cloneContentRef(source);

  assertEquals(cloned, {
    assetId: "asset-a",
    kind: "text",
    role: "body",
    mediaType: "text/plain",
    name: "note.txt",
    metadata: { source: "caller" },
  });
  source.metadata.source = "changed";
  assertEquals(cloned.metadata, { source: "caller" });
});

Deno.test("content ref canonicalization visits nested values and metadata", () => {
  const ref = {
    assetId: "asset-a",
    kind: "text" as const,
    role: "body",
    mediaType: "text/plain",
    value: "hydrated body",
    resolve: true,
    extra: "not durable",
  };
  assertEquals(
    canonicalizeContentRefs({
      ref,
      metadata: { nested: { ...ref, assetId: "asset-b" } },
      ordinary: [null, true, { label: "kept" }],
    }),
    {
      ref: {
        assetId: "asset-a",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
      },
      metadata: {
        nested: {
          assetId: "asset-b",
          kind: "text",
          role: "body",
          mediaType: "text/plain",
        },
      },
      ordinary: [null, true, { label: "kept" }],
    },
  );
});

Deno.test("content ref canonicalization retains descriptor-only resolution", () => {
  assertEquals(
    canonicalizeContentRefs({
      assetId: "asset-a",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
      resolve: false,
      value: "hydrated body",
    }),
    {
      assetId: "asset-a",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
      resolve: false,
    },
  );
});

Deno.test("JSON content materialization canonicalizes nested content refs", async () => {
  let candidate: ContentBodyCandidate | undefined;
  await materializeContentInput(
    {
      type: "json",
      value: {
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        ref: {
          assetId: "asset-a",
          kind: "json",
          role: "body",
          mediaType: "application/json",
          value: { hydrated: true },
          resolve: true,
        },
      },
    },
    { namespace: "test" },
    {
      materialize(value) {
        candidate = value;
        return Promise.resolve({
          assetId: "asset-json",
          kind: value.kind,
          role: value.role,
          mediaType: value.mediaType,
        } as ContentRef);
      },
      reference(ref) {
        return Promise.resolve(ref);
      },
    },
  );
  assertEquals(
    JSON.parse(new TextDecoder().decode(candidate!.body)),
    {
      createdAt: "2026-01-01T00:00:00.000Z",
      ref: {
        assetId: "asset-a",
        kind: "json",
        role: "body",
        mediaType: "application/json",
      },
    },
  );
});
