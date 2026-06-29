import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "jsr:@std/assert";

import {
  buildWhatsAppReplyButtonsMessage,
  callWhatsAppGraphAPI,
  normalizeWhatsAppActionPayload,
  normalizeWhatsAppReplyButtons,
} from "./shared.ts";

Deno.test("normalizeWhatsAppActionPayload unwraps nested ACTION payloads", () => {
  const normalized = normalizeWhatsAppActionPayload({
    sender: { type: "agent", id: "mobizap" },
    content: "Como voce gostaria de prosseguir com o pagamento?",
    action: {
      type: "reply_buttons",
      content: [
        { type: "text", text: "Cartao de Credito", payload: "credit_card" },
        { type: "text", text: "PIX", payload: "pix" },
      ],
    },
  });

  assertNotEquals(normalized, null);
  assertEquals(normalized, {
    type: "reply_buttons",
    message: "Como voce gostaria de prosseguir com o pagamento?",
    content: [
      { type: "text", text: "Cartao de Credito", payload: "credit_card" },
      { type: "text", text: "PIX", payload: "pix" },
    ],
  });
});

Deno.test("normalizeWhatsAppActionPayload keeps legacy flat action payloads", () => {
  const normalized = normalizeWhatsAppActionPayload({
    type: "reply_buttons",
    message: "Escolha uma opcao",
    content: [{ text: "Sim", payload: "sim" }],
  });

  assertEquals(normalized, {
    type: "reply_buttons",
    message: "Escolha uma opcao",
    content: [{ text: "Sim", payload: "sim" }],
  });
});

Deno.test("normalizeWhatsAppReplyButtons maps abstract buttons to WhatsApp buttons", () => {
  assertEquals(
    normalizeWhatsAppReplyButtons([
      { type: "text", text: "Cartao de Credito", payload: "credit_card" },
      { type: "text", text: "PIX", payload: "pix" },
    ]),
    [
      {
        type: "reply",
        reply: { id: "credit_card", title: "Cartao de Credito" },
      },
      { type: "reply", reply: { id: "pix", title: "PIX" } },
    ],
  );
});

Deno.test("normalizeWhatsAppReplyButtons enforces WhatsApp reply button constraints", () => {
  const normalized = normalizeWhatsAppReplyButtons([
    { text: "", payload: "empty" },
    { text: "Primeira opcao com titulo muito longo", payload: "same" },
    { text: "Segunda", payload: "same" },
    { text: "Terceira" },
    { text: "Quarta", payload: "fourth" },
  ]);

  assertEquals(normalized.length, 3);
  assertEquals(normalized[0].reply.id, "same");
  assertEquals(normalized[0].reply.title, "Primeira opcao com t");
  assertEquals(normalized[1].reply.id, "same_2");
  assertEquals(normalized[2].reply.id, "terceira");
});

Deno.test("buildWhatsAppReplyButtonsMessage builds Meta interactive reply buttons payload", () => {
  assertEquals(
    buildWhatsAppReplyButtonsMessage("5511999999999", {
      type: "reply_buttons",
      message: "Como voce gostaria de prosseguir?",
      content: [
        { text: "Cartao", payload: "credit_card" },
        { text: "PIX", payload: "pix" },
      ],
    }),
    {
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
    },
  );
});

Deno.test("buildWhatsAppReplyButtonsMessage returns null without a valid body or buttons", () => {
  assertEquals(
    buildWhatsAppReplyButtonsMessage("5511999999999", {
      type: "reply_buttons",
      message: "",
      content: [{ text: "PIX", payload: "pix" }],
    }),
    null,
  );
  assertEquals(
    buildWhatsAppReplyButtonsMessage("5511999999999", {
      type: "reply_buttons",
      message: "Escolha",
      content: [{ text: "", payload: "pix" }],
    }),
    null,
  );
});

Deno.test("WhatsApp channel debug logs sanitized Meta request and error response", async () => {
  const previousDebug = Deno.env.get("COPILOTZ_DEBUG_CHANNELS");
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const logs: unknown[][] = [];

  Deno.env.set("COPILOTZ_DEBUG_CHANNELS", "1");
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            message: "Invalid OAuth access token.",
            type: "OAuthException",
            code: 190,
            error_subcode: 463,
            fbtrace_id: "trace-123",
          },
        }),
        { status: 401 },
      ),
    )) as typeof fetch;
  console.log = (...args: unknown[]) => logs.push(args);
  console.error = () => {};

  try {
    const result = await callWhatsAppGraphAPI(
      {
        accessToken: "super-secret-token",
        phoneId: "phone-number-id",
        appSecret: "",
        webhookVerifyToken: "",
        graphApiVersion: "v25.0",
      },
      {
        messaging_product: "whatsapp",
        to: "5511999999999",
        type: "text",
        text: { body: "sensitive message" },
      },
    );

    assertEquals(result, null);
    assertEquals(logs, [
      [
        "[copilotz:channels:whatsapp]",
        {
          event: "message_send_request",
          graphApiVersion: "v25.0",
          phoneId: "phone-number-id",
          accessTokenConfigured: true,
          message: {
            type: "text",
            recipient: "***9999",
            textLength: 17,
            interactiveType: null,
          },
        },
      ],
      [
        "[copilotz:channels:whatsapp]",
        {
          event: "message_send_response",
          status: 401,
          ok: false,
          messageId: null,
          error: {
            message: "Invalid OAuth access token.",
            type: "OAuthException",
            code: 190,
            errorSubcode: 463,
            fbtraceId: "trace-123",
          },
        },
      ],
    ]);

    const serializedLogs = JSON.stringify(logs);
    assertEquals(serializedLogs.includes("super-secret-token"), false);
    assertEquals(serializedLogs.includes("sensitive message"), false);
    assertEquals(serializedLogs.includes("5511999999999"), false);
    assertStringIncludes(serializedLogs, "Invalid OAuth access token.");
  } finally {
    if (previousDebug === undefined) {
      Deno.env.delete("COPILOTZ_DEBUG_CHANNELS");
    } else {
      Deno.env.set("COPILOTZ_DEBUG_CHANNELS", previousDebug);
    }
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }
});
