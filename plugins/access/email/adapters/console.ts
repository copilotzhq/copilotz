/**
 * The `email` port's `console` adapter, for a laptop: each message is written
 * to the log instead of sent, so the flows can be followed without a mail
 * service (the code is there to copy). Never where the app is public: the
 * `email` plugin doesn't start with it then, since a code in a log is a way in.
 */
import type { EmailAdapter } from "../contract.ts";

const indent = (text: string) => text.split("\n").map((line) => `  ${line}`).join("\n");

export const consoleEmail: EmailAdapter = {
  send(message, { from }) {
    console.log(
      `\n[email] to ${message.to}${from ? `, from ${from}` : ""}\n  ${message.subject}\n\n` +
        `${indent(message.text)}\n`,
    );
    return Promise.resolve({});
  },
};
