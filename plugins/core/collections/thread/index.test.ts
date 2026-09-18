import { assertEquals, assertThrows } from "@std/assert";
import { threadCollection } from "./index.ts";
Deno.test("Thread Collection owns its name", () =>
  assertEquals(threadCollection.name, "thread"));

Deno.test("Thread patches one system namespace without replacing siblings", () => {
  const mutate = threadCollection.commands!.patchSystemMetadata.mutate;
  assertEquals(
    mutate({
      current: {
        metadata: {
          public: { topic: "keep" },
          system: { runtime: { attempt: 2 }, compass: { old: true } },
        },
      },
      input: { namespace: "compass", set: { teamProfileId: "profile-1" } },
    }),
    {
      set: {
        metadata: {
          public: { topic: "keep" },
          system: {
            runtime: { attempt: 2 },
            compass: { old: true, teamProfileId: "profile-1" },
          },
        },
      },
    },
  );
  assertEquals(
    mutate({
      current: {
        metadata: { system: { compass: { teamProfileId: "profile-1" } } },
      },
      input: { namespace: "compass", unset: ["teamProfileId"] },
    }),
    { set: { metadata: { public: {}, system: {} } } },
  );
});

Deno.test("Thread system metadata rejects protected namespaces and keys", () => {
  const mutate = threadCollection.commands!.patchSystemMetadata.mutate;
  assertThrows(() =>
    mutate({ current: { metadata: {} }, input: { namespace: "public" } })
  );
  assertThrows(() =>
    mutate({ current: { metadata: {} }, input: { namespace: "__proto__" } })
  );
  assertThrows(() =>
    mutate({
      current: { metadata: {} },
      input: {
        namespace: "compass",
        set: { ["__proto__"]: "unsafe" },
      },
    })
  );
  assertThrows(() =>
    mutate({
      current: { metadata: {} },
      input: { namespace: "compass", unset: ["constructor"] },
    })
  );
});
