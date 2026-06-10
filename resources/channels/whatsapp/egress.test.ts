import { assertEquals } from "jsr:@std/assert";

import { createWhatsAppEgressAdapter } from "./egress.ts";

function asyncEvents(events: unknown[]) {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function deliveryContext(
  events: unknown[],
  transform?: (output: unknown) => unknown,
) {
  return {
    route: { ingress: "web", egress: "whatsapp" },
    handle: { events: asyncEvents(events), done: Promise.resolve() },
    thread: {
      metadata: {
        system: {
          channels: {
            whatsapp: {
              recipientPhone: "5511999999999",
              channelId: "phone-number-id",
            },
          },
        },
      },
    },
    message: { content: "hi" },
    copilotz: {} as never,
    context: {
      channels: {
        whatsapp: {
          accessToken: "token",
          phoneId: "default-phone-id",
          appSecret: "secret",
          webhookVerifyToken: "verify",
          graphApiVersion: "v25.0",
        },
      },
    },
    transformDeliveryOutput: transform
      ? (output: unknown) => Promise.resolve(transform(output))
      : undefined,
  } as never;
}

Deno.test("WhatsApp egress sends ACTION reply_buttons as interactive buttons", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
    });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  }) as typeof fetch;

  try {
    await createWhatsAppEgressAdapter().deliver(deliveryContext([
      {
        type: "ACTION",
        payload: {
          sender: { type: "agent", id: "mobizap" },
          content: "Como voce gostaria de prosseguir?",
          action: {
            type: "reply_buttons",
            content: [
              { type: "text", text: "Cartao", payload: "credit_card" },
              { type: "text", text: "PIX", payload: "pix" },
            ],
          },
        },
      },
    ]));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(calls.length, 1);
  assertEquals(calls[0].body, {
    messaging_product: "whatsapp",
    to: "5511999999999",
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Como voce gostaria de prosseguir?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "credit_card", title: "Cartao" } },
          { type: "reply", reply: { id: "pix", title: "PIX" } },
        ],
      },
    },
  });
});

Deno.test("WhatsApp egress exposes reply button delivery output to channel overrides", async () => {
  const outputs: unknown[] = [];
  const calls: Array<{ body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  }) as typeof fetch;

  try {
    await createWhatsAppEgressAdapter().deliver(deliveryContext([
      {
        type: "ACTION",
        payload: {
          content: "Escolha",
          action: {
            type: "reply_buttons",
            content: [{ text: "PIX", payload: "pix" }],
          },
        },
      },
    ], (output) => {
      outputs.push(output);
      return {
        ...(output as Record<string, unknown>),
        to: "5511888888888",
      };
    }));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals((outputs[0] as Record<string, unknown>).kind, "reply_buttons");
  assertEquals((calls[0].body as Record<string, unknown>).to, "5511888888888");
});

Deno.test("WhatsApp egress ignores invalid reply button actions", async () => {
  const calls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  }) as typeof fetch;

  try {
    await createWhatsAppEgressAdapter().deliver(deliveryContext([
      {
        type: "ACTION",
        payload: {
          content: "Escolha",
          action: {
            type: "reply_buttons",
            content: [{ text: "", payload: "pix" }],
          },
        },
      },
    ]));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(calls, []);
});
