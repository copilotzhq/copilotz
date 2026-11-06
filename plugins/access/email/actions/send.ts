/**
 * `email.send`: one message, through the app's email port: the adapter the
 * `email` resource names (`resend`, or `console` on a laptop), from its
 * `from`. Trusted code's (sign-in's codes and links, an app's receipts),
 * never an actor's. Unrecorded: a message may carry a code or a link, which
 * the log never holds. A message that didn't go fails, saying so to anyone;
 * why is logged, without the message.
 */
import { defineAction, failure } from "../../../../runtime/mod.ts";
import type { EmailAdapter } from "../contract.ts";
import { EMAIL } from "../shared/inputs.ts";
import { emailOf } from "../shared/settings.ts";

export const sendAction = defineAction({
  description: "Sends an email through the app's email adapter",
  record: false,
  input: {
    type: "object",
    properties: {
      to: EMAIL,
      subject: { type: "string", minLength: 1, maxLength: 300 },
      text: { type: "string", minLength: 1, maxLength: 100_000 },
      html: { type: "string", maxLength: 500_000 },
    },
    required: ["to", "subject", "text"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const settings = emailOf(ctx);
    const adapter = ctx.adapters.email?.[settings.adapter] as EmailAdapter | undefined;
    if (!adapter) throw new Error(`No email adapter "${settings.adapter}"`);
    try {
      return await adapter.send(input, { from: settings.from ?? "", settings, fetch: ctx.fetch });
    } catch (error) {
      console.error(
        `email: ${settings.adapter} couldn't send a message:`,
        error instanceof Error ? error.message : error,
      );
      throw failure("unavailable", "We couldn't send the email. Try again in a moment.", {
        public: true,
      });
    }
  },
});
