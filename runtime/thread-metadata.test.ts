import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  getMemoryThreadMetadata,
  getPublicThreadMetadata,
  getRuntimeThreadMetadata,
  getSerializableThreadMetadata,
  normalizeThreadMetadata,
  setChannelContext,
  setMemoryThreadMetadata,
  setRuntimeThreadMetadata,
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
  assertEquals(normalized.system?.runtime, {
    participantTargets: { user: "agent-1" },
  });
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
      routing: {},
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
