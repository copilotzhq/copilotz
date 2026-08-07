import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import type { EventNativeRunInput } from "../attachments/index.ts";
import { type InteractiveCliIo, startInteractiveCli } from "../cli.ts";
import { createEphemeralEvent } from "../events/index.ts";

Deno.test("portable CLI preserves interactive run, rendering, and session commands", async () => {
  const answers = ["hello", "/status", "/exit"];
  const output: string[] = [];
  let ioClosed = 0;
  const io: InteractiveCliIo = Object.freeze({
    question: () => Promise.resolve(answers.shift() ?? "/exit"),
    write: (value) => output.push(value),
    close: () => {
      ioClosed += 1;
    },
    cwd: () => "/workspace",
  });
  const messages: EventNativeRunInput[] = [];
  const handle = startInteractiveCli({
    io,
    now: () => new Date("2026-08-06T00:00:00.000Z"),
    scope: {
      namespace: "tenant-a",
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["agent-a"],
    },
    agents: [{ id: "support", name: "Support" }],
    tools: [{ key: "lookup" }],
    performRun(message) {
      messages.push(message);
      const event = createEphemeralEvent({
        type: "text.delta",
        namespace: "tenant-a",
        threadId: "thread-a",
        payload: { text: "hi", agent: { name: "Support" } },
        correlationId: "correlation-a",
      });
      return Promise.resolve({
        eventId: "event-a",
        threadId: "thread-a",
        correlationId: "correlation-a",
        events: new ReadableStream({
          start(controller) {
            controller.enqueue(event);
            controller.close();
          },
        }),
        done: Promise.resolve(),
        cancel: () => Promise.resolve(),
      });
    },
  });

  await handle.closed;
  assertEquals(ioClosed, 1);
  assertEquals(messages.length, 1);
  assertEquals(messages[0].content, "hello");
  assertEquals(messages[0].thread, "thread-a");
  assertEquals(messages[0].namespace, "tenant-a");
  const rendered = output.join("");
  assertStringIncludes(rendered, "Copilotz Interactive Session");
  assertStringIncludes(rendered, "assistant Support");
  assertStringIncludes(rendered, "answer>");
  assertStringIncludes(rendered, "last event id: event-a");
  assertStringIncludes(rendered, "Ending session. Goodbye.");
});

Deno.test("portable CLI is factory-first and imports no host terminal API", async () => {
  const source = await Deno.readTextFile(new URL("../cli.ts", import.meta.url));
  assert(!/^\s*(?:export\s+)?class\s/m.test(source));
  assert(!/from\s+["']node:|\bDeno\.|\bBun\.|\bprocess\./.test(source));
});
