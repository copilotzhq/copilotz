/**
 * Resend's API (`POST https://api.resend.com/emails`), as the `email` port's
 * `resend` adapter: one message, from the `email` resource's `from` (a
 * domain Resend verified), with its `apiKey`. It calls out with the `fetch`
 * it's given (`ctx.fetch`, which tests replace).
 */
import type { EmailAdapter } from "../contract.ts";

const API = "https://api.resend.com/emails";

export const resend: EmailAdapter = {
  async send(message, { from, settings, fetch }) {
    if (!settings.apiKey) throw new Error("Resend: the email resource has no apiKey");
    const response = await fetch(API, {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(settings.replyTo ? { reply_to: settings.replyTo } : {}),
      }),
    });
    if (!response.ok) {
      const said = await response.json().catch(() => null) as { message?: unknown } | null;
      const why = typeof said?.message === "string" ? `: ${said.message.slice(0, 200)}` : "";
      throw new Error(`Resend: HTTP ${response.status}${why}`);
    }
    const sent = await response.json().catch(() => ({})) as { id?: unknown };
    return typeof sent.id === "string" ? { id: sent.id } : {};
  },
};
