import { assert, assertEquals, assertRejects } from "@std/assert";
import { runProviderStream } from "./stream.ts";
import { LLMStreamTimeoutError } from "../../shared/errors.ts";
import type { ProviderAPI, ProviderConfig } from "../../shared/types.ts";
import { builtinProviders } from "../builtin/providers.ts";

/** Manual timers: tests advance logical time, never wait for a timeout. */
function clock() {
  const original = { setTimeout, clearTimeout, now: Date.now, fetch };
  let now = 0, sequence = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  globalThis.setTimeout = ((run: () => void, delay = 0) => {
    const id = ++sequence;
    timers.set(id, { at: now + delay, run });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout =
    ((id: number) => timers.delete(id)) as typeof clearTimeout;
  Date.now = () => now;
  const flush = async () => {
    // Drain the bounded promise pipeline (HTTP -> parser -> bridge).
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  return {
    flush,
    async advance(ms: number) {
      const until = now + ms;
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].run();
        await flush();
      }
      now = until;
      await flush();
    },
    restore() {
      globalThis.setTimeout = original.setTimeout;
      globalThis.clearTimeout = original.clearTimeout;
      globalThis.fetch = original.fetch;
      Date.now = original.now;
      assertEquals(timers.size, 0, "watchdogs must be released");
    },
  };
}
const api: ProviderAPI = {
  endpoint: "https://example.test/model",
  headers: () => ({}),
  body: () => ({}),
  extractContent: (data) =>
    data.text ? [{ text: data.text, isReasoning: !!data.reasoning }] : null,
};
const config: ProviderConfig = {
  firstTokenTimeoutMs: 10,
  streamIdleTimeoutMs: 10,
  attemptTimeoutMs: 100,
};
function source() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(value) {
            controller = value;
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
  return {
    frame(value: unknown) {
      controller.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`),
      );
    },
    heartbeat() {
      controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
    },
    close() {
      controller.close();
    },
    cancelled: () => cancelled,
  };
}

for (
  const activity of ["reasoning", "metadata", "heartbeat", "content"] as const
) {
  Deno.test(`provider ${activity} renews liveness beyond the old shortened cap`, async () => {
    const time = clock();
    try {
      const stream = source();
      const result = runProviderStream([], undefined, config, api);
      await time.flush();
      // Old shortened cap = 30; safety backstop = 100; idle window = 10.
      for (let n = 0; n < 8; n++) {
        await time.advance(8);
        if (activity === "heartbeat") stream.heartbeat();
        else {stream.frame(
            activity === "metadata" ? { status: "working" } : {
              text: "working",
              reasoning: activity === "reasoning",
            },
          );}
        await time.flush();
        assertEquals(stream.cancelled(), false);
      }
      stream.frame({ text: "done" });
      stream.close();
      assert((await result).content.endsWith("done"));
    } finally {
      time.restore();
    }
  });
}

Deno.test("provider idle expiry has a specific user-facing reason and cancels I/O", async () => {
  const time = clock();
  try {
    const stream = source();
    const result = runProviderStream([], undefined, config, api);
    await time.flush();
    stream.frame({ text: "hello" });
    await time.flush();
    const rejected = assertRejects(
      () => result,
      LLMStreamTimeoutError,
      "The model stopped responding",
    );
    await time.advance(9);
    assertEquals(stream.cancelled(), false);
    await time.advance(1);
    assertEquals((await rejected).kind, "idle");
    assertEquals(stream.cancelled(), true);
  } finally {
    time.restore();
  }
});

Deno.test("provider safety backstop still bounds endless progress", async () => {
  const time = clock();
  try {
    const stream = source();
    const result = runProviderStream([], undefined, {
      ...config,
      attemptTimeoutMs: 30,
    }, api);
    const rejected = assertRejects(
      () => result,
      LLMStreamTimeoutError,
      "safety backstop",
    );
    await time.flush();
    for (let n = 0; n < 3; n++) {
      await time.advance(8);
      stream.heartbeat();
      await time.flush();
    }
    await time.advance(6);
    assertEquals((await rejected).kind, "attempt");
  } finally {
    time.restore();
  }
});

Deno.test("provider watchdog covers asynchronous request preparation", async () => {
  const time = clock();
  const body = Promise.withResolvers<object>();
  try {
    let requests = 0;
    globalThis.fetch = () => {
      requests++;
      throw new Error("unexpected request");
    };
    const result = runProviderStream([], undefined, config, {
      ...api,
      body: () => body.promise,
    });
    const rejected = assertRejects(
      () => result,
      LLMStreamTimeoutError,
      "The model stopped responding",
    );
    await time.advance(10);
    assertEquals((await rejected).kind, "first_token");
    body.resolve({});
    await time.flush();
    assertEquals(requests, 0, "late preparation must not start a paid call");
  } finally {
    body.resolve({});
    time.restore();
  }
});

Deno.test("local-stop usage drain retains its inactivity watchdog", async () => {
  const time = clock();
  try {
    const stream = source();
    const result = runProviderStream([], undefined, {
      ...config,
      stop: ["STOP"],
    }, api);
    await time.flush();
    stream.frame({ text: "answerSTOP" });
    await time.flush();
    const completed = await result;
    assertEquals(completed.content, "answer");
    assert(completed.usageFinalized);
    const rejected = assertRejects(
      () => completed.usageFinalized!,
      LLMStreamTimeoutError,
      "The model stopped responding",
    );
    await time.advance(8);
    stream.heartbeat();
    await time.flush();
    await time.advance(9);
    assertEquals(stream.cancelled(), false);
    await time.advance(1);
    assertEquals((await rejected).kind, "idle");
  } finally {
    time.restore();
  }
});

for (
  const [label, provider, factory, options] of [
    ...Object.entries(builtinProviders).map(([name, factory]) =>
      [name, name, factory, {}] as const
    ),
    ["openai chat completions", "openai", builtinProviders.openai, {
      openaiApi: "chat_completions",
    }] as const,
  ]
) {
  Deno.test(`${label}: built-in provider path has a first-activity watchdog`, async () => {
    const time = clock();
    try {
      const stream = source();
      const providerConfig = {
        ...config,
        ...options,
        provider,
        model: "test-model",
        apiKey: "test",
      } as ProviderConfig;
      const result = runProviderStream(
        [],
        undefined,
        providerConfig,
        factory(providerConfig),
      );
      const rejected = assertRejects(
        () => result,
        LLMStreamTimeoutError,
        "The model stopped responding",
      );
      await time.flush();
      await time.advance(10);
      assertEquals((await rejected).kind, "first_token");
      assertEquals(stream.cancelled(), true);
    } finally {
      time.restore();
    }
  });
}

Deno.test("external cancellation rejects even an uncooperative preparation without starting I/O", async () => {
  const time = clock();
  const abort = new AbortController();
  const body = Promise.withResolvers<object>();
  try {
    let requests = 0;
    globalThis.fetch = () => {
      requests++;
      throw new Error("unexpected request");
    };
    const result = runProviderStream(
      [],
      undefined,
      config,
      { ...api, body: () => body.promise },
      undefined,
      abort.signal,
    );
    const rejected = assertRejects(() => result, Error, "worker lease lost");
    abort.abort(new Error("worker lease lost"));
    await rejected;
    body.resolve({});
    await time.flush();
    assertEquals(requests, 0);
  } finally {
    body.resolve({});
    time.restore();
  }
});
