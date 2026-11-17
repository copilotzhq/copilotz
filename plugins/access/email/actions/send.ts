/**
 * `email.send`: one message, through the app's email port: the adapter the
 * `email` resource names (`resend`, `smtp`, `sendmail`, or `console` on a laptop), from
 * its `from` or another address it allows (the message's own `from`: one of
 * its `senders`), with where replies go (`replyTo`) and files
 * (`attachments`, in base64: 10 at most, 10 MiB in all; one with an `id` is
 * inline, which the HTML points to as `cid:id`). Trusted code's
 * (sign-in's codes and links, an app's receipts and invoices), never an
 * actor's. Unrecorded: a message may carry a code or a link, which the log
 * never holds. A message that didn't go fails, saying so to anyone; why is
 * logged, without the message.
 */
import { defineAction, failure } from "../../../../runtime/mod.ts";
import type { EmailAdapter, EmailMessage } from "../contract.ts";
import { addressOf, allowed } from "../shared/addresses.ts";
import { EMAIL } from "../shared/inputs.ts";
import { emailOf } from "../shared/settings.ts";

/** The most a message's files may weigh, in all (bytes, decoded). */
const MOST = 10 * 1024 * 1024;

/** No line ends where a header goes: what's typed there never starts another header. */
const LINE = /[\r\n]/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const attachment = {
  type: "object",
  properties: {
    filename: { type: "string", minLength: 1, maxLength: 255 },
    contentType: { type: "string", pattern: "^[\\w.+-]+/[\\w.+-]+$", maxLength: 255 },
    /** Its bytes, in base64. */
    content: { type: "string", maxLength: 14_000_000 },
    /** Inline: its Content-ID, which the HTML points to as `cid:<id>`. */
    id: { type: "string", pattern: "^[\\w.+-]+(@[\\w.-]+)?$", minLength: 1, maxLength: 200 },
  },
  required: ["filename", "content"],
  additionalProperties: false,
} as const;

/** Refuses what would make a message other than the one asked for, or one too heavy. */
function checked(message: EmailMessage) {
  for (const [field, value] of Object.entries({ ...message, attachments: undefined })) {
    if (field !== "text" && field !== "html" && typeof value === "string" && LINE.test(value)) {
      throw failure("invalid", `email.send: a message's ${field} is one line`);
    }
  }
  let weight = 0;
  if (message.attachments?.some((file) => file.id) && !message.html) {
    throw failure("invalid", "email.send: an inline file (with an id) needs an html body");
  }
  for (const file of message.attachments ?? []) {
    if (LINE.test(file.filename)) throw failure("invalid", "email.send: a file's name is one line");
    const content = file.content.replace(/\s+/g, "");
    if (content.length % 4 === 1 || !BASE64.test(content)) {
      throw failure("invalid", `email.send: ${file.filename}'s content isn't base64`);
    }
    weight += Math.floor(content.length * 3 / 4);
  }
  if (weight > MOST) throw failure("invalid", "email.send: a message's files are 10 MiB at most");
}

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
      /** Who it's from, when not the app's `from`: one its `senders` allow. */
      from: { type: "string", minLength: 3, maxLength: 320 },
      replyTo: EMAIL,
      attachments: { type: "array", items: attachment, maxItems: 10 },
    },
    required: ["to", "subject", "text"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const settings = emailOf(ctx);
    const adapter = ctx.adapters.email?.[settings.adapter] as EmailAdapter | undefined;
    if (!adapter) throw new Error(`No email adapter "${settings.adapter}"`);
    const message = input as EmailMessage;
    checked(message);
    if (message.from && !allowed(settings, message.from)) {
      throw failure(
        "invalid",
        `email.send: ${addressOf(message.from)} isn't an address the email resource allows ` +
          "(its from, or one of its senders)",
      );
    }
    try {
      return await adapter.send(message, {
        from: message.from ?? settings.from ?? "",
        settings,
        fetch: ctx.fetch,
      });
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
