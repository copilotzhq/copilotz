import type { EmailAdapter, EmailMessage } from "../contract.ts";
import { mime } from "../shared/mime.ts";

/** An in-process email adapter. Inspect its messages in delivery order and clear them between checks. */
export type CapturedMail = EmailAdapter & {
  readonly messages: readonly (EmailMessage & { from: string })[];
  /** Forget the messages in memory. Files already written stay in the directory. */
  clear(): void;
};

/** Make an isolated mailbox for an app or test. Give it a directory to save each message as an .eml file too. */
export function captureEmail(options: { directory?: string } = {}): CapturedMail {
  const messages: (EmailMessage & { from: string })[] = [];
  return {
    messages,
    clear() {
      messages.length = 0;
    },
    async send(message, { from, settings }) {
      const replyTo = message.replyTo ?? settings.replyTo;
      const sent = structuredClone({ ...message, from, ...(replyTo ? { replyTo } : {}) });
      const directory = options.directory ?? settings.capture?.directory;
      if (directory) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { source } = mime(sent, from);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${crypto.randomUUID()}.eml`), source, {
          flag: "wx",
          mode: 0o600,
        });
      }
      messages.push(sent);
      return {};
    },
  };
}
