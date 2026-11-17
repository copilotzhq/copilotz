/**
 * The `email` port's `sendmail` adapter: one message handed to a
 * sendmail-compatible program (Postfix's, Exim's, msmtp's…), as mime.ts
 * writes it, on its stdin. It runs
 * `path -i -f <sender> [args…] -- <recipient>` with `node:child_process`:
 * an argument array, never a shell, so nothing in an address is ever a
 * command. Recipients are arguments after `--` (not read from the headers,
 * which a program's `-t` would), so a header can't add one. A non-zero
 * exit fails with the program's stderr (trimmed), and so does a timeout
 * (30 s unless `sendmail.timeout`). On Node, Deno and Bun, not workerd.
 */
import type { EmailAdapter } from "../contract.ts";
import { addressOf } from "../shared/addresses.ts";
import { mime } from "../shared/mime.ts";

/** What an address may hold to be one argument: printable ASCII, no space, quote, angle or backslash. */
const SAFE = /^[\x21-\x7e]+$/;
const BAD = /["'<>\\]/;

export const sendmail: EmailAdapter = {
  async send(message, { from, settings }) {
    if (!from) throw new Error("Sendmail: the email resource has no from");
    const config = settings.sendmail ?? {};
    const path = config.path ?? "/usr/sbin/sendmail";
    const timeout = config.timeout ?? 30_000;
    const sender = addressOf(from);
    const recipient = addressOf(message.to);
    for (const address of [sender, recipient]) {
      if (!SAFE.test(address) || BAD.test(address)) {
        throw new Error(`Sendmail: "${address}" isn't an address`);
      }
    }
    const { source, id } = mime(message, from, { replyTo: settings.replyTo });
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      const args = ["-i", "-f", sender, ...config.args ?? [], "--", recipient];
      const child = spawn(path, args, { stdio: ["pipe", "ignore", "pipe"], shell: false });
      let stderr = "";
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`Sendmail: ${path} didn't finish in ${timeout / 1000} s`));
      }, timeout);
      child.stderr?.on("data", (chunk: unknown) => {
        if (stderr.length < 4096) stderr += String(chunk);
      });
      child.on("error", (error: Error) => finish(new Error(`Sendmail: ${path}: ${error.message}`)));
      child.on("close", (code: number | null, signal: string | null) => {
        if (code === 0) return finish();
        const said = stderr.trim().slice(0, 500);
        finish(
          new Error(
            `Sendmail: ${path} ${signal ? `was stopped by ${signal}` : `exited ${code}`}` +
              (said ? `: ${said}` : ""),
          ),
        );
      });
      // A program that exits before it reads it all closes the pipe: its exit says why.
      child.stdin?.on("error", () => {});
      child.stdin?.end(source.replace(/\r\n/g, "\n"));
    });
    return { id };
  },
};
