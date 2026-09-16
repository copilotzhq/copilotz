import { assertEquals } from "@std/assert";
import {
  addThreadTag,
  getPublicThreadMetadata,
  getSerializableThreadMetadata,
  getThreadTags,
  normalizeThreadMetadata,
  removeThreadTag,
  setThreadTags,
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
Deno.test("thread tags normalize from public metadata", () => {
  const metadata = {
    public: {
      tags: [
        "Important",
        { id: "tag_sales", name: "Sales", color: "#22c55e" },
        { id: "tag_sales", name: "Sales duplicate" },
        { name: "important" },
        { name: "" },
      ],
    },
  };

  assertEquals(getThreadTags(metadata), [
    { id: "tag_important", name: "Important" },
    { id: "tag_sales", name: "Sales", color: "#22c55e" },
  ]);
});

Deno.test("setThreadTags updates public tags without replacing public metadata", () => {
  const metadata = setThreadTags(
    {
      public: {
        project: "alpha",
        tags: [{ id: "tag_old", name: "Old" }],
      },
      system: {
        runtime: {
          agentTurnCount: 2,
        },
      },
    },
    [{ id: "tag_new", name: "New" }],
  );

  assertEquals(getPublicThreadMetadata(metadata), {
    project: "alpha",
    tags: [{ id: "tag_new", name: "New" }],
  });
  assertEquals(metadata.system?.runtime, {
    agentTurnCount: 2,
  });
});

Deno.test("addThreadTag and removeThreadTag preserve normalized tag list", () => {
  const withTags = addThreadTag(
    {
      public: {
        tags: [{ id: "tag_existing", name: "Existing" }],
      },
    },
    { name: "Next Tag" },
  );

  assertEquals(getThreadTags(withTags), [
    { id: "tag_existing", name: "Existing" },
    { id: "tag_next-tag", name: "Next Tag" },
  ]);

  assertEquals(
    getThreadTags(removeThreadTag(withTags, "tag_existing")),
    [{ id: "tag_next-tag", name: "Next Tag" }],
  );
});
