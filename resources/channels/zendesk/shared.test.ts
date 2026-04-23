import { assertEquals, assertNotEquals } from "jsr:@std/assert";

import { normalizeZendeskActionPayload } from "./shared.ts";

Deno.test("normalizeZendeskActionPayload unwraps nested ACTION payloads", () => {
  const normalized = normalizeZendeskActionPayload({
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

Deno.test("normalizeZendeskActionPayload keeps legacy flat action payloads", () => {
  const normalized = normalizeZendeskActionPayload({
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
