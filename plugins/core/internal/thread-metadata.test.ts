import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  addThreadTag,
  getMemoryThreadMetadata,
  getPublicThreadMetadata,
  getRuntimeThreadMetadata,
  getSerializableThreadMetadata,
  getThreadTags,
  normalizeThreadMetadata,
  removeThreadTag,
  setChannelContext,
  setMemoryThreadMetadata,
  setRuntimeThreadMetadata,
  setThreadTags,
} from "./thread-metadata.ts";

Deno.test("thread metadata separates public and system fields", () => {
  const legacy = {
    topic: "support",
    participantTargets: { user: "agent-1" },
    public: {
      locale: "en-US",
    },
    system: {
      channels: {
        zendesk: { conversationId: "conv-1" },
      },
      routing: {
        egress: "zendesk",
      },
    },
  };

  const normalized = normalizeThreadMetadata(legacy);

  assertEquals(normalized.public, {
    topic: "support",
    locale: "en-US",
  });
  assertEquals(normalized.system?.runtime, {});
  assertEquals(normalized.system?.memory, {
    identity: {},
  });
  assertEquals(normalized.system?.channels, {
    zendesk: { conversationId: "conv-1" },
  });
});

Deno.test("public metadata excludes runtime and channel routing state", () => {
  const metadata = setChannelContext(
    setMemoryThreadMetadata(
      setRuntimeThreadMetadata(
        { project: "alpha" },
        { agentTurnCount: 2 },
      ),
      { identity: { userExternalId: "user-1" } },
    ),
    "whatsapp",
    { recipientPhone: "+5511999999999" },
  );

  assertEquals(getPublicThreadMetadata(metadata), {
    project: "alpha",
  });
  assertEquals(getRuntimeThreadMetadata(metadata), {
    agentTurnCount: 2,
  });
  assertEquals(getMemoryThreadMetadata(metadata), {
    identity: {
      userExternalId: "user-1",
    },
  });
  assertEquals(getSerializableThreadMetadata(metadata), {
    public: { project: "alpha" },
    system: {
      runtime: {
        agentTurnCount: 2,
      },
      memory: {
        identity: {
          userExternalId: "user-1",
        },
      },
      channels: {
        whatsapp: { recipientPhone: "+5511999999999" },
      },
    },
  });
});

Deno.test("deprecated participant targets and system routing metadata are dropped", () => {
  const normalized = normalizeThreadMetadata({
    participantTargets: { user: "agent-1" },
    system: {
      runtime: {
        participantTargets: { user: "agent-2" },
        agentTurnCount: 1,
      },
      routing: { staleTarget: "agent-3" },
    },
  });

  assertEquals(normalized, {
    public: {},
    system: {
      runtime: { agentTurnCount: 1 },
      memory: { identity: {} },
      channels: {},
    },
  });
});

Deno.test("legacy userExternalId normalizes into memory metadata", () => {
  const metadata = setChannelContext(
    setRuntimeThreadMetadata(
      { project: "alpha" },
      { agentTurnCount: 2 },
    ),
    "whatsapp",
    { recipientPhone: "+5511999999999" },
  );

  const legacy = {
    ...metadata,
    system: {
      ...(metadata.system ?? {}),
      runtime: {
        ...(metadata.system?.runtime ?? {}),
        userExternalId: "legacy-user",
      },
    },
  };

  assertEquals(getPublicThreadMetadata(legacy), {
    project: "alpha",
  });
  assertEquals(getRuntimeThreadMetadata(legacy), {
    agentTurnCount: 2,
  });
  assertEquals(getMemoryThreadMetadata(legacy), {
    identity: {
      userExternalId: "legacy-user",
    },
  });
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
  assertEquals(getRuntimeThreadMetadata(metadata), {
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
