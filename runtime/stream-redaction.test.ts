import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { redactEventForStream } from "./stream-redaction.ts";

Deno.test("redactEventForStream redacts sensitive nested keys", () => {
  const event = {
    type: "LLM_CALL",
    payload: {
      config: {
        provider: "openai",
        model: "gpt-4.1",
        apiKey: "sk-secret",
        headers: {
          Authorization: "Bearer secret",
          "X-API-Key": "secret-key",
          "Content-Type": "application/json",
        },
        fallbacks: [
          {
            provider: "anthropic",
            apiKey: "fallback-secret",
          },
        ],
      },
    },
    metadata: {
      secret: "top-secret",
      totalTokens: 123,
    },
  };

  assertEquals(redactEventForStream(event), {
    type: "LLM_CALL",
    payload: {
      config: {
        provider: "openai",
        model: "gpt-4.1",
        apiKey: "[REDACTED]",
        headers: {
          Authorization: "[REDACTED]",
          "X-API-Key": "[REDACTED]",
          "Content-Type": "application/json",
        },
        fallbacks: [
          {
            provider: "anthropic",
            apiKey: "[REDACTED]",
          },
        ],
      },
    },
    metadata: {
      secret: "[REDACTED]",
      totalTokens: 123,
    },
  });
});

Deno.test("redactEventForStream preserves dates and non-sensitive fields", () => {
  const createdAt = new Date("2026-04-16T00:00:00.000Z");
  const event = {
    id: "evt-1",
    createdAt,
    payload: {
      token: "secret-token",
      totalTokens: 42,
    },
  };

  const redacted = redactEventForStream(event);

  assertEquals(redacted.id, "evt-1");
  assertEquals(redacted.createdAt, createdAt);
  assertEquals(redacted.payload, {
    token: "secret-token",
    totalTokens: 42,
  });
});

Deno.test("redactEventForStream still redacts auth token fields", () => {
  const event = {
    payload: {
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      authToken: "auth-secret",
    },
  };

  assertEquals(redactEventForStream(event), {
    payload: {
      accessToken: "[REDACTED]",
      refreshToken: "[REDACTED]",
      authToken: "[REDACTED]",
    },
  });
});

Deno.test("redactEventForStream skips TOKEN events entirely", () => {
  const event = {
    type: "TOKEN",
    payload: {
      token: "visible model output",
      accessToken: "should-stay-because-token-events-bypass-redaction",
    },
  };

  assertEquals(redactEventForStream(event), event);
});
