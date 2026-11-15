/**
 * SMTP, as a client (RFC 5321): one message to a server, over `node:net`
 * and `node:tls`, which Node, Deno and Bun all have (workerd doesn't). It
 * greets the server (EHLO), moves to TLS (from the start when `secure`, else
 * with STARTTLS, refused when the server doesn't offer it unless `starttls`
 * is false), signs in (AUTH PLAIN, else LOGIN), then says who it's from and
 * to, and the message (its lines starting with a dot doubled), and leaves.
 * Each step waits for the server's answer (`timeout`, 30 s); an answer that
 * isn't the one it needs ends it, saying which, never the password.
 */
import type { SmtpSettings } from "../contract.ts";

/** A server's answer: its code, and its lines. */
type Reply = { code: number; lines: string[] };

/** The socket a conversation is over: what `node:net` and `node:tls` give. */
type Socket = {
  write(text: string): unknown;
  on(event: string, listener: (value: never) => void): unknown;
  removeAllListeners(event?: string): unknown;
  setTimeout?(ms: number): unknown;
  destroy(): unknown;
  end(): unknown;
};

/** What `node:tls` takes to connect (or to move a socket to TLS). */
type TlsOptions = {
  host?: string;
  port?: number;
  socket?: Socket;
  servername: string;
  ca?: string;
};

/** The answers a socket brings, one at a time; what ends it ends them. */
function answers(timeout: number) {
  let buffer = "";
  let lines: string[] = [];
  const ready: Reply[] = [];
  let waiting: { resolve(reply: Reply): void; reject(error: Error): void } | undefined;
  let ended: Error | undefined;
  const take = (chunk: unknown) => {
    buffer += String(chunk);
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, "");
      buffer = buffer.slice(at + 1);
      lines.push(line.slice(4));
      // `250-…` goes on; `250 …` (or a bare code) ends an answer.
      if (line[3] !== "-") {
        ready.push({ code: Number(line.slice(0, 3)), lines });
        lines = [];
      }
    }
    if (waiting && ready.length) {
      const next = waiting;
      waiting = undefined;
      next.resolve(ready.shift()!);
    }
  };
  const end = (error: Error) => {
    ended ??= error;
    waiting?.reject(ended);
    waiting = undefined;
  };
  return {
    listen(socket: Socket) {
      socket.on("data", take);
      socket.on("error", (error: Error) => end(error));
      socket.on("close", () => end(new Error("the server closed the connection")));
    },
    next(): Promise<Reply> {
      if (ready.length) return Promise.resolve(ready.shift()!);
      if (ended) return Promise.reject(ended);
      return new Promise<Reply>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = undefined;
          reject(new Error(`no answer from the server in ${timeout / 1000} s`));
        }, timeout);
        waiting = {
          resolve: (reply) => {
            clearTimeout(timer);
            resolve(reply);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
      });
    },
  };
}

/** The message's lines, each starting with a dot doubled, then the dot that ends it. */
export const stuffed = (source: string): string =>
  source.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..").replace(/(\r\n)?$/, "\r\n.\r\n");

const base64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes));
};

/**
 * Sends `source` (the message, as mime.ts makes it) from `from` to `to`
 * through the server: the server's last answer (its words, often the
 * message's id there).
 */
export async function smtpSend(
  settings: SmtpSettings,
  envelope: { from: string; to: string[] },
  source: string,
  name: string,
): Promise<string> {
  const net = await import("node:net");
  const tls = await import("node:tls");
  const secure = settings.secure ?? settings.port === 465;
  const port = settings.port ?? (secure ? 465 : 587);
  const timeout = settings.timeout ?? 30_000;
  const said = answers(timeout);
  const connect = tls.connect as unknown as (options: TlsOptions) => Socket;
  const secured = (options: TlsOptions) =>
    connect({ ...options, ...(settings.ca ? { ca: settings.ca } : {}) });
  let socket: Socket = secure
    ? secured({ host: settings.host, port, servername: settings.host })
    : net.connect({ host: settings.host, port }) as unknown as Socket;
  said.listen(socket);
  const send = (line: string) => socket.write(`${line}\r\n`);
  /** The next answer, refused unless its code is one of `codes`; `what` says which step. */
  const expect = async (what: string, ...codes: number[]) => {
    const reply = await said.next();
    if (!codes.includes(reply.code)) {
      const words = reply.lines.join(" ").slice(0, 200);
      throw new Error(`SMTP ${what}: the server answered ${reply.code} ${words}`.trim());
    }
    return reply;
  };
  /** Greets the server: what it offers, by keyword (`AUTH` with its ways). */
  const hello = async () => {
    send(`EHLO ${name}`);
    const reply = await expect("EHLO", 250);
    return new Map(
      reply.lines.slice(1).map((line) => {
        const [word, ...rest] = line.trim().split(/\s+/);
        return [word.toUpperCase(), rest.map((r) => r.toUpperCase())];
      }),
    );
  };
  try {
    await expect("greeting", 220);
    let offers = await hello();
    if (!secure) {
      if (offers.has("STARTTLS")) {
        send("STARTTLS");
        await expect("STARTTLS", 220);
        socket.removeAllListeners("data");
        socket.removeAllListeners("error");
        socket.removeAllListeners("close");
        socket = secured({ socket, servername: settings.host });
        said.listen(socket);
        offers = await hello();
      } else if (settings.starttls !== false) {
        throw new Error(
          "SMTP: the server doesn't offer STARTTLS; say secure: true for TLS from the start, or " +
            "starttls: false for a server on this machine",
        );
      }
    }
    if (settings.user) {
      const ways = offers.get("AUTH") ?? [];
      if (ways.includes("PLAIN")) {
        send(`AUTH PLAIN ${base64(`\0${settings.user}\0${settings.password ?? ""}`)}`);
        await expect("AUTH", 235);
      } else if (ways.includes("LOGIN")) {
        send("AUTH LOGIN");
        await expect("AUTH", 334);
        send(base64(settings.user));
        await expect("AUTH", 334);
        send(base64(settings.password ?? ""));
        await expect("AUTH", 235);
      } else {
        throw new Error(
          "SMTP: the server offers no way to sign in this client speaks (PLAIN, LOGIN)",
        );
      }
    }
    send(`MAIL FROM:<${envelope.from}>`);
    await expect("MAIL FROM", 250);
    for (const to of envelope.to) {
      send(`RCPT TO:<${to}>`);
      await expect("RCPT TO", 250, 251);
    }
    send("DATA");
    await expect("DATA", 354);
    socket.write(stuffed(source));
    const done = await expect("the message", 250);
    send("QUIT");
    await said.next().catch(() => undefined);
    return done.lines.join(" ");
  } finally {
    socket.end();
    socket.destroy();
  }
}
