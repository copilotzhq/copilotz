import { assertEquals } from "jsr:@std/assert";

import { createWebEgressAdapter } from "./egress.ts";

function asyncEvents(events: unknown[]) {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

Deno.test("web egress skips native persisted messages to avoid duplicate rendering", async () => {
  const delivered: unknown[] = [];
  const adapter = createWebEgressAdapter();

  await adapter.deliver({
    route: { ingress: "web", egress: "web" },
    callback: (event: unknown) => delivered.push(event),
    handle: {
      events: asyncEvents([
        { type: "TOKEN", payload: { token: "Hello" } },
        {
          type: "LLM_RESULT",
          payload: { answer: "Hello", status: "completed" },
        },
        {
          type: "message.created",
          operation: "created",
          payload: {
            sender: { type: "agent", id: "north" },
            content: "Hello",
          },
        },
      ]),
      done: Promise.resolve(),
    },
  } as never);

  assertEquals(
    delivered.map((event) => (event as { type?: string }).type),
    ["TOKEN", "LLM_RESULT"],
  );
});
