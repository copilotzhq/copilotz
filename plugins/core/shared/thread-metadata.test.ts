import { assertEquals } from "@std/assert";
import {
  getPublicThreadMetadata,
  getSerializableThreadMetadata,
  normalizeThreadMetadata,
} from "./thread-metadata.ts";
Deno.test("current thread metadata keeps system namespaces private without promoting flat keys", () => {
  const input = {
    topic: "legacy",
    userExternalId: "legacy-user",
    public: { locale: "en" },
    system: { channels: { web: { id: "a" } }, memory: { secret: "hidden" } },
  };
  const value = normalizeThreadMetadata(input);
  assertEquals(value, { public: { locale: "en" }, system: input.system });
  assertEquals(getPublicThreadMetadata(input), { locale: "en" });
  value.system!.memory = {};
  assertEquals(input.system.memory, { secret: "hidden" });
  assertEquals(
    getSerializableThreadMetadata({ userExternalId: "legacy-user" }),
    null,
  );
});

Deno.test("generic public metadata remains available through the envelope", () => {
  const input = {
    public: { project: "alpha", custom: { priority: "high" } },
    system: { runtime: { attempt: 2 } },
  };
  assertEquals(normalizeThreadMetadata(input), input);
  assertEquals(getPublicThreadMetadata(input), input.public);
  assertEquals(getSerializableThreadMetadata(input), input);
});
