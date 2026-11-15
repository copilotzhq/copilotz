/**
 * The `email` port's `smtp` adapter: one message through a mail server (the
 * `email` resource's `smtp`: its host, port, TLS, user and password), as
 * mime.ts writes it, from whom it's from, with where replies go and its
 * files. On Node, Deno and Bun, which have `node:net` and `node:tls` (loaded
 * only when it sends); not on workerd, which opens no such sockets: send
 * with `resend` there. Its answer is the message's id (`Message-ID`).
 */
import type { EmailAdapter } from "../contract.ts";
import { addressOf } from "../shared/addresses.ts";
import { mime } from "../shared/mime.ts";
import { smtpSend } from "../shared/smtp.ts";

export const smtp: EmailAdapter = {
  async send(message, { from, settings }) {
    const server = settings.smtp;
    if (!server?.host) throw new Error("SMTP: the email resource has no smtp.host");
    if (!from) throw new Error("SMTP: the email resource has no from");
    const { source, id } = mime(message, from, { replyTo: settings.replyTo });
    const sender = addressOf(from);
    await smtpSend(
      server,
      { from: sender, to: [addressOf(message.to)] },
      source,
      server.name ?? sender.split("@")[1] ?? "localhost",
    );
    return { id };
  },
};
