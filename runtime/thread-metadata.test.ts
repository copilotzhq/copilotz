import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  getPublicThreadMetadata,
  getRuntimeThreadMetadata,
  getSerializableThreadMetadata,
  normalizeThreadMetadata,
  setChannelContext,
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
  assertEquals(normalized.system?.channels, {
    zendesk: { conversationId: "conv-1" },
  });
});

Deno.test("public metadata excludes runtime and channel routing state", () => {
  const metadata = setChannelContext(
    setRuntimeThreadMetadata(
      { project: "alpha" },
      { userExternalId: "user-1", agentTurnCount: 2 },
    ),
    "whatsapp",
    { recipientPhone: "+5511999999999" },
  );

  assertEquals(getPublicThreadMetadata(metadata), {
    project: "alpha",
  });
  assertEquals(getRuntimeThreadMetadata(metadata), {
    userExternalId: "user-1",
    agentTurnCount: 2,
  });
  assertEquals(getSerializableThreadMetadata(metadata), {
    public: { project: "alpha" },
    system: {
      runtime: {
        userExternalId: "user-1",
        agentTurnCount: 2,
      },
      channels: {
        whatsapp: { recipientPhone: "+5511999999999" },
      },
      routing: {},
    },
  });
});
