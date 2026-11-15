/**
 * The `email` port's `console` adapter, for a laptop: each message is written
 * to the log instead of sent, so the flows can be followed without a mail
 * service (the code is there to copy). Never where the app is public: the
 * `email` plugin doesn't start with it then, since a code in a log is a way in.
 */
import type { EmailAdapter } from "../contract.ts";

const indent = (text: string) => text.split("\n").map((line) => `  ${line}`).join("\n");

/** A file's size, from its base64. */
const sizeOf = (base64: string) => {
  const kib = Math.floor(base64.replace(/\s+/g, "").length * 3 / 4) / 1024;
  return kib < 1024 ? `${Math.ceil(kib)} KiB` : `${(kib / 1024).toFixed(1)} MiB`;
};

export const consoleEmail: EmailAdapter = {
  send(message, { from, settings }) {
    const replies = message.replyTo ?? settings.replyTo;
    const files = (message.attachments ?? []).map((file) =>
      `\n  + ${file.filename} (${sizeOf(file.content)})`
    ).join("");
    console.log(
      `\n[email] to ${message.to}${from ? `, from ${from}` : ""}` +
        `${replies ? `, replies to ${replies}` : ""}\n  ${message.subject}\n\n` +
        `${indent(message.text)}\n${files ? `${files}\n` : ""}`,
    );
    return Promise.resolve({});
  },
};
