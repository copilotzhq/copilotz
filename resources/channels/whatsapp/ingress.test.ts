import { assertEquals } from "jsr:@std/assert";

import { createWhatsAppIngressAdapter } from "./ingress.ts";

function webhookRequest(message: Record<string, unknown>) {
  return {
    method: "POST",
    headers: {},
    query: {},
    body: {
      entry: [
        {
          id: "business-id",
          changes: [
            {
              value: {
                metadata: { phone_number_id: "phone-id" },
                contacts: [{ profile: { name: "Vinicius" } }],
                messages: [message],
              },
            },
          ],
        },
      ],
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("ingress parses an interactive button reply into text content", async () => {
  const adapter = createWhatsAppIngressAdapter();

  const result = await adapter.handle(
    webhookRequest({
      from: "5511999999999",
      id: "wamid.1",
      timestamp: "1",
      type: "interactive",
      interactive: {
        type: "button_reply",
        button_reply: { id: "pix", title: "PIX" },
      },
    }),
    // deno-lint-ignore no-explicit-any
    {} as any,
  );

  assertEquals(result.messages?.length, 1);
  assertEquals(result.messages?.[0]?.message.content, "PIX");
});

Deno.test("ingress parses an interactive list reply into text content", async () => {
  const adapter = createWhatsAppIngressAdapter();

  const result = await adapter.handle(
    webhookRequest({
      from: "5511999999999",
      id: "wamid.2",
      timestamp: "2",
      type: "interactive",
      interactive: {
        type: "list_reply",
        list_reply: { id: "trip_6", title: "Opção 6", description: "23:55" },
      },
    }),
    // deno-lint-ignore no-explicit-any
    {} as any,
  );

  assertEquals(result.messages?.[0]?.message.content, "Opção 6");
});

Deno.test("ingress still parses plain text messages", async () => {
  const adapter = createWhatsAppIngressAdapter();

  const result = await adapter.handle(
    webhookRequest({
      from: "5511999999999",
      id: "wamid.3",
      timestamp: "3",
      type: "text",
      text: { body: "Olá" },
    }),
    // deno-lint-ignore no-explicit-any
    {} as any,
  );

  assertEquals(result.messages?.[0]?.message.content, "Olá");
});
