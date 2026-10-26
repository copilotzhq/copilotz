import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { nativeChatFixture } from "./native-chat-fixture.test.ts";
import type {
  LlmAdapterResult,
  LlmInvocation,
} from "../../../llm/shared/contracts.ts";

function invocation(result: Promise<LlmAdapterResult>): LlmInvocation {
  return {
    frames: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    result,
  };
}
const answer: LlmAdapterResult = {
  content: "The complete answer after reconnecting.",
  attempts: [{ status: "completed" }],
  finishReason: "stop",
};
const sender = { id: "sender", participantType: "human", externalId: "sender" };
const agent = {
  id: "agent",
  participantType: "agent",
  agentId: "assistant",
  externalId: "assistant",
};
async function start(f: Awaited<ReturnType<typeof nativeChatFixture>>) {
  await f.invoke("login", {});
  await f.invoke("createThread", {
    id: "thread",
    participants: [sender, agent],
  });
  await f.invoke("createThreadMessage", {
    id: "question",
    threadId: "thread",
    sender,
    recipientIds: ["agent"],
    content: "Answer this question",
  });
}
function network() {
  return new TypeError("fetch failed", {
    cause: new Error("peer closed connection without sending TLS close_notify"),
  });
}

Deno.test("native Agent retries an incomplete network call, preserves the primary cause across a fallback skip, and emits one reply", async () => {
  const second = Promise.withResolvers<void>();
  const release = Promise.withResolvers<LlmAdapterResult>();
  const f = await nativeChatFixture({
    missingFallback: true,
    provider(call) {
      if (call === 1) return invocation(Promise.reject(network()));
      second.resolve();
      return invocation(release.promise);
    },
  });
  try {
    await start(f);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        second.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Retry did not start")),
            20_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    assertEquals(f.calls, 2);
    assertEquals(await f.events("llm.call.failed"), []);
    assertEquals(
      (await f.records("message")).filter((m) => m.senderId === "agent"),
      [],
    );
    release.resolve(answer);
    await f.settled();
    assertEquals(f.calls, 2);
    assertEquals((await f.events("llm.call.completed")).length, 1);
    assertEquals(await f.events("llm.call.failed"), []);
    const replies = (await f.records("message")).filter((m) =>
      m.senderId === "agent"
    );
    assertEquals(replies.length, 1);
    assertEquals(await f.text(replies[0]), answer.content);
    assertEquals(
      (await f.deliveries()).slice(0, 1).map((d) => [d.status, d.attempts]),
      [[
        "succeeded",
        2,
      ]],
    );
  } finally {
    release.resolve(answer);
    await f.close();
  }
});

for (const permanent of [false, true]) {
  Deno.test(`native Agent ${permanent ? "auth rejection fails once" : "network exhaustion fails only after three attempts"}`, async () => {
    const f = await nativeChatFixture({
      missingFallback: true,
      provider() {
        return invocation(
          Promise.reject(
            permanent
              ? Object.assign(new Error("invalid API key"), { status: 401 })
              : network(),
          ),
        );
      },
    });
    try {
      await start(f);
      await f.settled(true);
      assertEquals(f.calls, permanent ? 1 : 3);
      const failures = await f.events("llm.call.failed");
      assertEquals(failures.length, 1);
      const error = failures[0].payload.error as {
        message: string;
        code: string;
      };
      assertEquals(
        error.code,
        permanent ? "llm_provider_auth_error" : "llm_provider_network",
      );
      assertStringIncludes(
        error.message,
        permanent ? "credentials" : "Failed after 3 attempts",
      );
      assert(!error.message.includes("No LLM credential"));
      const replies = (await f.records("message")).filter((m) =>
        m.senderId === "agent"
      );
      assertEquals(replies.length, 1);
      assertEquals(
        await f.text(replies[0]),
        `${error.message} Please try again.`,
      );
      // The terminal failure is durable and shown; the router settles the
      // delivery instead of dead-lettering it.
      assertEquals(
        (await f.deliveries()).slice(0, 1).map((d) => [d.status, d.attempts]),
        [[
          "succeeded",
          permanent ? 1 : 3,
        ]],
      );
    } finally {
      await f.close();
    }
  });
}

Deno.test("independent Agent recipients overlap and retry only the failed provider", async () => {
  let primary = 0, peer = 0;
  const both = Promise.withResolvers<void>();
  const f = await nativeChatFixture({
    peerAgent: true,
    provider(_call, input) {
      if (input.model === "peer") peer++;
      else primary++;
      if (peer && primary) both.resolve();
      return invocation((async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            both.promise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Recipients did not overlap")),
                5000,
              );
            }),
          ]);
          if (input.model !== "peer" && primary === 1) throw network();
          return answer;
        } finally {
          if (timer) clearTimeout(timer);
        }
      })());
    },
  });
  try {
    await f.invoke("login", {});
    await f.invoke("createThread", {
      id: "thread",
      participants: [sender, agent, {
        id: "peer",
        externalId: "peer",
        participantType: "agent",
        agentId: "peer",
      }],
    });
    await f.invoke("createThreadMessage", {
      id: "parallel",
      threadId: "thread",
      sender,
      recipientIds: ["agent", "peer"],
      content: "Both answer",
    });
    await f.settled();
    assertEquals(primary, 2);
    assertEquals(peer, 1);
    assertEquals(await f.events("llm.call.failed"), []);
    const replies = (await f.records("message")).filter((m) =>
      m.senderId !== "sender"
    );
    assertEquals(replies.length, 2);
    for (const reply of replies) {
      assertEquals(await f.text(reply), answer.content);
    }
  } finally {
    both.resolve();
    await f.close();
  }
});
