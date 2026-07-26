import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Agent, Event } from "@/types/index.ts";
import { buildTurnControlMessage } from "./index.ts";

Deno.test("buildTurnControlMessage appends explicit active and return ownership", () => {
  const message = buildTurnControlMessage(
    { id: "west", name: "Lead", role: "assistant" } as Agent,
    {
      metadata: {
        targetQueue: ["user-1"],
      },
    } as unknown as Event,
    true,
  );

  assertEquals(message.role, "user");
  assertStringIncludes(String(message.content), "<turn_control>");
  assertStringIncludes(String(message.content), "active_agent: west");
  assertStringIncludes(String(message.content), "returns_to: user-1");
  assertStringIncludes(String(message.content), "call consult_agent");
  assertStringIncludes(
    String(message.content),
    "Calling a normal tool keeps you active",
  );
});

Deno.test("buildTurnControlMessage omits unavailable consultation guidance", () => {
  const message = buildTurnControlMessage(
    { id: "solo", name: "Solo", role: "assistant" } as Agent,
    { metadata: {} } as unknown as Event,
    false,
  );

  assertStringIncludes(String(message.content), "returns_to: requester");
  assertEquals(String(message.content).includes("consult_agent"), false);
});
