import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type {
  LlmAuthResolution,
  LlmConnectionContext,
} from "../../shared/contracts.ts";
import {
  type ChatGptAccount,
  type ChatGptConnectionOptions,
  createChatGptConnection,
} from "./index.ts";
import { deriveChatGptCodexCacheKey } from "../../shared/internal-cache-key.ts";

const timestamp = 1_700_000_000_000;
const initial: ChatGptAccount = Object.freeze({
  id: "linked-account",
  accountId: "provider-account",
  version: "revision-1",
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: timestamp - 1,
});
function context(
  namespace = "tenant-one",
  signal = new AbortController().signal,
) {
  return { namespace, signal } as unknown as LlmConnectionContext;
}
function resolver(options: Partial<ChatGptConnectionOptions> = {}) {
  const connection = createChatGptConnection({
    oauth: { clientId: "application-registration" },
    load: () => initial,
    save: (_context, previous, tokens) => ({
      ...previous,
      ...tokens,
      version: "revision-2",
    }),
    markExpired: () => null,
    now: () => timestamp,
    fetch: () => {
      throw new Error("Unexpected network request");
    },
    ...options,
  });
  const resolve = (connection as unknown as {
    auth: {
      resolve(
        context: LlmConnectionContext,
        execution: { connection: string },
      ): Promise<LlmAuthResolution>;
    };
  }).auth.resolve;
  return (scope = context()) => resolve(scope, { connection: "chatgpt" });
}
function success(refreshToken: string | undefined = "new-refresh") {
  return Response.json({
    access_token: "new-access",
    expires_in: 3_600,
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
  });
}

Deno.test("ChatGPT connection requires the application's OAuth registration", () => {
  assertThrows(() => resolver({ oauth: { clientId: "" } }), TypeError);
});
Deno.test("ChatGPT connection uses valid tokens without refreshing", async () => {
  const resolve = resolver({
    load: () => ({ ...initial, expiresAt: timestamp + 120_000 }),
  });
  assertEquals(await resolve(), {
    available: true,
    apiKey: "old-access",
    extraHeaders: { "ChatGPT-Account-ID": "provider-account" },
  });
});
Deno.test("ChatGPT refresh uses explicit registration, rotates tokens, and awaits persistence", async () => {
  let saved = false;
  const resolve = resolver({
    fetch: async (url, init) => {
      assertEquals(url, "https://auth.openai.com/oauth/token");
      assertEquals(init?.redirect, "error");
      assertEquals(
        new URLSearchParams(String(init?.body)).get("client_id"),
        "application-registration",
      );
      assertEquals(
        new URLSearchParams(String(init?.body)).get("refresh_token"),
        "old-refresh",
      );
      return success();
    },
    save: (_context, previous, tokens) => {
      assertEquals(previous, initial);
      assertEquals(tokens, {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: timestamp + 3_600_000,
      });
      saved = true;
      return { ...previous, ...tokens, version: "revision-2" };
    },
  });
  assertEquals((await resolve() as { apiKey: string }).apiKey, "new-access");
  assert(saved);
});

Deno.test("ChatGPT token refresh keeps the account-derived cache session stable", async () => {
  const resolved = await resolver({ fetch: async () => success() })();
  const accountId =
    (resolved as { extraHeaders: Record<string, string> }).extraHeaders[
      "ChatGPT-Account-ID"
    ];
  assertEquals(
    await deriveChatGptCodexCacheKey(accountId, "tenant", "thread", "agent"),
    await deriveChatGptCodexCacheKey(
      initial.accountId,
      "tenant",
      "thread",
      "agent",
    ),
  );
});
Deno.test("ChatGPT refresh preserves an omitted refresh token", async () => {
  const resolve = resolver({
    fetch: async () =>
      Response.json({ access_token: "new-access", expires_in: 3_600 }),
    save: (_context, previous, tokens) => {
      assertEquals(tokens.refreshToken, "old-refresh");
      return { ...previous, ...tokens, version: "revision-2" };
    },
  });
  assertEquals((await resolve()).available, true);
});
Deno.test("ChatGPT account failures never expose credentials or mark transient failures expired", async () => {
  let expired = 0;
  for (
    const fetch of [
      async () =>
        Response.json({ error: "temporarily_unavailable", detail: "secret" }, {
          status: 503,
        }),
      async () => Response.json({ error: "invalid_client" }, { status: 400 }),
      async () => Response.json({ access_token: "secret", expires_in: "bad" }),
      async () => {
        throw new Error("secret token in transport error");
      },
    ]
  ) {
    assertEquals(
      await resolver({
        fetch,
        markExpired: () => {
          expired++;
          return null;
        },
      })(),
      { available: false },
    );
  }
  assertEquals(expired, 0);
  assertEquals(
    await resolver({
      load: () => {
        throw new Error("decrypted secret");
      },
    })(),
    { available: false },
  );
});
Deno.test("ChatGPT invalid grant expires only the unchanged account snapshot", async () => {
  let expired = 0;
  const resolve = resolver({
    fetch: async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    markExpired: (_context, previous) => {
      assertEquals(previous.version, "revision-1");
      expired++;
      return null;
    },
  });
  assertEquals(await resolve(), { available: false });
  assertEquals(expired, 1);
});
Deno.test("ChatGPT invalid grant retains a newly refreshed winner", async () => {
  let loads = 0;
  const resolve = resolver({
    load: () =>
      ++loads === 1 ? initial : {
        ...initial,
        version: "winner",
        accessToken: "winner-access",
        expiresAt: timestamp + 120_000,
      },
    fetch: async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    markExpired: () => {
      throw new Error("Must not expire the winner");
    },
  });
  assertEquals((await resolve() as { apiKey: string }).apiKey, "winner-access");
});
Deno.test("ChatGPT refresh returns the conditional storage winner and rejects account switches", async () => {
  const winner = {
    ...initial,
    version: "winner",
    accessToken: "winner-access",
    expiresAt: timestamp + 120_000,
  };
  assertEquals(
    (await resolver({ fetch: async () => success(), save: () => winner })() as {
      apiKey: string;
    }).apiKey,
    "winner-access",
  );
  assertEquals(
    await resolver({
      fetch: async () => success(),
      save: () => ({ ...winner, accountId: "other-user" }),
    })(),
    { available: false },
  );
});
Deno.test("ChatGPT shares refresh within an account revision while cancelled waiters detach", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response>();
  let requests = 0;
  const resolve = resolver({
    fetch: async () => {
      requests++;
      started.resolve();
      return await release.promise;
    },
  });
  const controller = new AbortController();
  const first = resolve(context("tenant-one", controller.signal));
  await started.promise;
  const second = resolve();
  controller.abort();
  await assertRejects(() => first, DOMException);
  release.resolve(success());
  assertEquals((await second).available, true);
  assertEquals(requests, 1);
});
Deno.test("ChatGPT refresh coordination never crosses tenant boundaries", async () => {
  const release = Promise.withResolvers<void>();
  let requests = 0;
  const resolve = resolver({
    fetch: async () => {
      if (++requests === 2) release.resolve();
      await release.promise;
      return success();
    },
  });
  assertEquals(
    (await Promise.all([resolve(context("one")), resolve(context("two"))])).map(
      (value) => value.available,
    ),
    [true, true],
  );
  assertEquals(requests, 2);
});
