import { assertEquals, assertThrows } from "@std/assert";

import type { Agent } from "../resources/index.ts";
import {
  agentTextBaseConfig,
  agentUsesSessionRuntime,
  resolveAgentRuntime,
  staticAgentSessionConfig,
  staticAgentTextConfig,
} from "./config.ts";

function agent(runtime: Agent["runtime"]): Agent {
  return {
    id: "support",
    name: "Support",
    role: "assistant",
    runtime,
  };
}

Deno.test("agentTextBaseConfig reads the generate-mode runtime", () => {
  const config = agentTextBaseConfig(agent({
    provider: "openai",
    model: "primary",
    apiKey: "secret",
    fallbacks: [{ provider: "anthropic", model: "backup" }],
  }));
  assertEquals(config.provider, "openai");
  assertEquals(config.model, "primary");
  assertEquals(config.apiKey, "secret");
  assertEquals(config.fallbacks, [{ provider: "anthropic", model: "backup" }]);
});

Deno.test("resolveAgentRuntime selects session independently of generate", () => {
  const resource = agent([
    { provider: "openai", model: "gpt" },
    { mode: "session", provider: "realtime.echo", voice: "alloy" },
  ]);
  assertEquals(resolveAgentRuntime(resource, "generate")?.provider, "openai");
  assertEquals(resolveAgentRuntime(resource, "session")?.provider, "realtime.echo");
  assertEquals(agentTextBaseConfig(resource).provider, "openai");
});

Deno.test("staticAgentSessionConfig requires a session provider", () => {
  assertThrows(
    () => staticAgentSessionConfig(agent({ provider: "openai", model: "gpt" })),
    Error,
    "has no session runtime provider",
  );
});

Deno.test("staticAgentTextConfig requires a generate provider", () => {
  assertThrows(
    () => staticAgentTextConfig(agent({ mode: "session", provider: "realtime.echo" })),
    Error,
    "has no generate runtime provider",
  );
});

Deno.test("agentUsesSessionRuntime is true only for session-only agents", () => {
  assertEquals(
    agentUsesSessionRuntime(agent({
      mode: "session",
      provider: "realtime.echo",
    })),
    true,
  );
  assertEquals(
    agentUsesSessionRuntime(agent({ provider: "openai", model: "gpt" })),
    false,
  );
  assertEquals(
    agentUsesSessionRuntime(agent([
      { provider: "openai", model: "gpt" },
      { mode: "session", provider: "realtime.echo" },
    ])),
    false,
  );
});

Deno.test("resolveAgentRuntime rejects two runtimes in the same mode", () => {
  assertThrows(
    () =>
      resolveAgentRuntime(agent([
        { provider: "openai" },
        { provider: "anthropic" },
      ])),
    Error,
    "more than one generate runtime",
  );
});
