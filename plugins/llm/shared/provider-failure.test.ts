import { assertEquals } from "@std/assert";
import { providerFailure, providerRetryAfter } from "./provider-failure.ts";
import { LLMProviderError, LLMStreamTimeoutError } from "./errors.ts";
import { LlmAdapterCallError } from "./contracts.ts";

Deno.test("incomplete provider failures retain retry disposition through adapter causes", () => {
  const cases: [unknown, string, boolean][] = [
    [
      new TypeError("fetch failed", { cause: new Error("TLS close_notify") }),
      "network",
      true,
    ],
    [
      Object.assign(new Error("socket broke"), { code: "ECONNRESET" }),
      "network",
      true,
    ],
    [new DOMException("deadline", "TimeoutError"), "timeout", true],
    [Object.assign(new Error("denied"), { status: 401 }), "auth_error", false],
    [
      Object.assign(new Error("invalid request"), { status: 400 }),
      "provider_error",
      false,
    ],
    [Object.assign(new Error("busy"), { status: 429 }), "rate_limit", true],
    [
      Object.assign(new Error("unavailable"), { status: 503 }),
      "server_error",
      true,
    ],
    [
      new LLMProviderError("quota", {
        provider: "openai",
        reason: "billing_error",
      }),
      "billing_error",
      false,
    ],
  ];
  for (const [cause, reason, retryable] of cases) {
    const disposition = providerFailure(
      new LlmAdapterCallError("adapter failed", { cause }),
    );
    assertEquals(disposition?.code, `llm_provider_${reason}`);
    assertEquals(disposition?.retryable, retryable);
  }
  assertEquals(providerFailure(new TypeError("invalid frame")), undefined);
  assertEquals(
    providerFailure(new Error("unclassified adapter error")),
    undefined,
  );
});

Deno.test("Retry-After supports delta seconds and HTTP dates with a bounded delay", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assertEquals(providerRetryAfter("2", now), 2000);
  assertEquals(providerRetryAfter("Thu, 01 Jan 2026 00:00:03 GMT", now), 3000);
  assertEquals(providerRetryAfter("9999", now), 30_000);
  assertEquals(providerRetryAfter("-1", now), undefined);
  assertEquals(providerRetryAfter("nonsense", now), undefined);
  assertEquals(providerRetryAfter(null, now), undefined);
  const error = new LlmAdapterCallError("rate limited", {
    cause: Object.assign(new Error("limit"), {
      status: 429,
      retryAfterMs: 2000,
    }),
  });
  assertEquals(providerFailure(error)?.retryAfterMs, 2000);
});

Deno.test("HTTP transport captures Retry-After without retaining it as an opaque error body", async () => {
  const { request } = await import("../adapters/bridge/http.ts");
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response("busy", {
        status: 429,
        headers: { "retry-after": "2" },
      }),
    );
  try {
    let failure: unknown;
    try {
      await request("https://provider.test", { stream: true });
    } catch (error) {
      failure = error;
    }
    assertEquals(providerFailure(failure)?.retryAfterMs, 2000);
    assertEquals(providerFailure(failure)?.retryable, true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("content refusal remains permanent even if an earlier transport reason is retained", () => {
  const error = new LLMProviderError("refused", {
    reason: "network",
    provider: "openai",
    providerError: { code: "content_policy_violation" },
  });
  assertEquals(providerFailure(error)?.code, "llm_provider_provider_error");
  assertEquals(providerFailure(error)?.retryable, false);
});

Deno.test("typed model stalls retain a specific safe message through adapter wrapping", () => {
  for (const kind of ["first_token", "idle", "attempt", "total"] as const) {
    const failure = providerFailure(
      new LlmAdapterCallError("generic", {
        cause: new LLMProviderError("generic", {
          provider: "openai",
          reason: "timeout",
          cause: new LLMStreamTimeoutError(kind, 10),
        }),
      }),
    );
    assertEquals(failure?.code, "llm_provider_timeout");
    assertEquals(failure?.retryable, true);
    assertEquals(
      failure?.message,
      kind === "first_token" || kind === "idle"
        ? "The model stopped responding."
        : "The model exceeded its configured safety backstop.",
    );
  }
});
