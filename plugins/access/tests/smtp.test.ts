/**
 * The `email` port through a mail server (the `smtp` adapter), against a
 * fake one that keeps what it was told: STARTTLS and TLS from the start,
 * AUTH PLAIN and LOGIN, the message as MIME (text and HTML as alternatives,
 * files beside them, what isn't ASCII encoded), and the refusals: a server
 * without STARTTLS, a wrong password. And `email.send` itself: who a message
 * may be from, where replies go, files through Resend, headers that stay one
 * line.
 */
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { createRuntime, definePlugin, type Runtime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access, email, type EmailAttachment } from "../mod.ts";
import { quotedPrintable } from "../email/shared/mime.ts";
import { stuffed } from "../email/shared/smtp.ts";
import { CA, fakeSmtp } from "./smtp-fake.ts";
import { test } from "../../../testing/mod.ts";

const decoder = new TextDecoder();
const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const base64Of = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Quoted-printable, read back. */
function unquoted(text: string): string {
  const joined = text.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=") {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(joined.charCodeAt(i));
  }
  return decoder.decode(new Uint8Array(bytes));
}

/** Encoded words, read back (the space between two of them is no space). */
const unworded = (text: string) =>
  text.replace(/\?=\s+=\?/g, "?==?").replace(
    /=\?UTF-8\?B\?([^?]*)\?=/g,
    (_, b64: string) => decoder.decode(bytesOf(b64)),
  );

/** A block's headers (lowercased names, unfolded) and its body. */
function split(block: string) {
  const at = block.indexOf("\r\n\r\n");
  const head = block.slice(0, at).replace(/\r\n[ \t]/g, " ");
  const headers: Record<string, string> = Object.fromEntries(
    head.split("\r\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }),
  );
  return { headers, body: block.slice(at + 4) };
}

/** A message's parts, by boundary, leaves only: each one's headers and body. */
function parts(source: string): { headers: Record<string, string>; body: string }[] {
  const found: { headers: Record<string, string>; body: string }[] = [];
  const walk = (block: string) => {
    const { headers, body } = split(block);
    const boundary = /boundary="([^"]+)"/.exec(headers["content-type"] ?? "")?.[1];
    if (!boundary) return found.push({ headers, body });
    for (const piece of body.split(`--${boundary}`).slice(1, -1)) {
      walk(piece.replace(/^\r\n/, "").replace(/\r\n$/, ""));
    }
  };
  walk(source);
  return found;
}

/** A PDF's first bytes and some more: what a file is, for these tests. */
const PDF = new Uint8Array([
  0x25,
  0x50,
  0x44,
  0x46,
  0x2d,
  ...Array.from({ length: 300 }, (_, i) => i % 256),
]);

async function start(settings: Record<string, unknown>, fetch?: typeof globalThis.fetch) {
  return await createRuntime({
    store: memoryStore(),
    plugins: [
      ...access,
      email,
      definePlugin({ name: "app", resources: { email: settings } }),
    ],
    ...(fetch ? { fetch } : {}),
  });
}

const code = (p: Promise<unknown>) =>
  p.then(() => "sent", (e) => (e as { code?: string }).code ?? String(e));

test("SMTP: text, HTML and a file, over STARTTLS, signed in with PLAIN", async () => {
  const server = await fakeSmtp({ tls: "starttls", user: "loja", password: "s3nha" });
  const rt = await start({
    adapter: "smtp",
    from: "Loja Ação <loja@example.com>",
    replyTo: "atendimento@example.com",
    smtp: { host: "localhost", port: server.port, user: "loja", password: "s3nha", ca: CA },
  });
  try {
    const subject = "Sua nota fiscal nº 123 — obrigado pela compra, João!";
    const text = "Olá João,\nsegue a nota.\n.\nUma linha que começa com ponto, e uma bem longa: " +
      "x".repeat(120);
    const sent = await rt.call<{ id?: string }>("email.send", {
      to: "Joao@Example.com",
      subject,
      text,
      html: "<p>Olá <b>João</b>, segue a nota.</p>",
      attachments: [{ filename: "nota fiscal.pdf", content: base64Of(PDF) }],
    });
    // It moved to TLS before anything was said, and signed in there.
    const [plain, secure] = server.said;
    assertEquals([plain.secure, plain.auth, plain.from], [false, undefined, undefined]);
    assertEquals(secure.secure, true);
    assertEquals(secure.ehlo, ["example.com"]);
    assertEquals(secure.auth, { way: "PLAIN", user: "loja", password: "s3nha" });
    assertEquals([secure.from, secure.to], ["loja@example.com", ["joao@example.com"]]);
    // The message: every line ASCII and 76 at most (998 is the limit), its headers as said.
    const source = secure.data!;
    assert(
      source.split("\r\n").every((line) => line.length <= 78 && /^[\x20-\x7e\t]*$/.test(line)),
    );
    const top = split(source);
    const [plainText, html, file] = parts(source);
    assertEquals(unworded(top.headers.subject), subject);
    assertEquals(unworded(top.headers.from), "Loja Ação <loja@example.com>");
    assertEquals(top.headers.to, "joao@example.com");
    assertEquals(top.headers["reply-to"], "atendimento@example.com");
    assertEquals(top.headers["message-id"], sent.id);
    assertMatch(sent.id!, /^<[0-9a-f-]{36}@example\.com>$/);
    assertMatch(top.headers["content-type"], /^multipart\/mixed; boundary="=_copilotz_/);
    assertEquals(plainText.headers["content-type"], "text/plain; charset=utf-8");
    assertEquals(unquoted(plainText.body).replace(/\r\n$/, ""), text.replace(/\n/g, "\r\n"));
    assertEquals(unquoted(html.body), "<p>Olá <b>João</b>, segue a nota.</p>");
    assertEquals(file.headers["content-type"], "application/pdf");
    assertEquals(
      file.headers["content-disposition"],
      'attachment; filename="nota fiscal.pdf"',
    );
    assertEquals(bytesOf(file.body.replace(/\r\n/g, "")), PDF);
  } finally {
    await rt.close();
    await server.close();
  }
});

test("SMTP: TLS from the start, and LOGIN when that's all the server offers", async () => {
  const server = await fakeSmtp({ tls: "implicit", auth: ["LOGIN"], user: "u", password: "p" });
  const rt = await start({
    adapter: "smtp",
    from: "app@example.com",
    smtp: { host: "localhost", port: server.port, secure: true, user: "u", password: "p", ca: CA },
  });
  try {
    await rt.call("email.send", { to: "ana@example.com", subject: "Oi", text: "Oi." });
    assertEquals(server.said.length, 1);
    assertEquals(server.said[0].secure, true);
    assertEquals(server.said[0].auth, { way: "LOGIN", user: "u", password: "p" });
    assertEquals(server.said[0].to, ["ana@example.com"]);
  } finally {
    await rt.close();
    await server.close();
  }
});

test("SMTP: no STARTTLS, no message unless the app says so; a wrong password says it didn't go", async () => {
  const server = await fakeSmtp({ tls: "none", user: "u", password: "p" });
  const smtp = { host: "localhost", port: server.port, user: "u", password: "p", ca: CA };
  const message = { to: "ana@example.com", subject: "Oi", text: "Oi." };
  const errors = console.error;
  console.error = () => {};
  try {
    const refusing = await start({ adapter: "smtp", from: "app@example.com", smtp });
    assertEquals(await code(refusing.call("email.send", message)), "unavailable");
    assertEquals(server.said.at(-1)?.auth, undefined);
    await refusing.close();
    // A server on this machine, plain: said so.
    const local = await start({
      adapter: "smtp",
      from: "app@example.com",
      smtp: { ...smtp, starttls: false },
    });
    assertEquals(await code(local.call("email.send", message)), "sent");
    assertEquals(server.said.at(-1)?.data !== undefined, true);
    await local.close();
    const wrong = await start({
      adapter: "smtp",
      from: "app@example.com",
      smtp: { ...smtp, starttls: false, password: "nope" },
    });
    assertEquals(await code(wrong.call("email.send", message)), "unavailable");
    assertEquals(server.said.at(-1)?.data, undefined);
    await wrong.close();
    // The adapter needs its server, and who mail is from.
    await assertRejects(() => start({ adapter: "smtp", from: "app@example.com" }), Error, "smtp");
    await assertRejects(() => start({ adapter: "smtp", smtp }), Error, "from");
  } finally {
    console.error = errors;
    await server.close();
  }
});

/** An adapter that keeps what it's handed. */
function keeping() {
  const kept: { message: Record<string, unknown>; from: string }[] = [];
  const plugin = definePlugin({
    name: "keeping",
    adapters: {
      email: {
        keep: {
          send: (message: Record<string, unknown>, use: { from: string }) => {
            kept.push({ message, from: use.from });
            return Promise.resolve({ id: `m${kept.length}` });
          },
        },
      },
    },
  });
  return { kept, plugin };
}

test("email.send: from what the app allows, replies where said, headers one line, files light enough", async () => {
  const { kept, plugin } = keeping();
  const rt: Runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      ...access,
      email,
      plugin,
      definePlugin({
        name: "app",
        resources: {
          email: {
            adapter: "keep",
            from: "App <noreply@example.com>",
            senders: ["Billing <billing@example.com>", "@brand.example"],
          },
        },
      }),
    ],
  });
  try {
    const base = { to: "ana@example.com", subject: "Oi", text: "Oi." };
    await rt.call("email.send", base);
    await rt.call("email.send", {
      ...base,
      from: "Cobrança <BILLING@example.com>",
      replyTo: "fin@example.com",
    });
    await rt.call("email.send", { ...base, from: "Brand <hello@brand.example>" });
    assertEquals(kept.map((k) => k.from), [
      "App <noreply@example.com>",
      "Cobrança <BILLING@example.com>",
      "Brand <hello@brand.example>",
    ]);
    assertEquals(kept[1].message.replyTo, "fin@example.com");
    for (
      const refused of [
        { ...base, from: "someone@else.example" },
        { ...base, from: "x@sub.brand.example" },
        { ...base, subject: "Oi\r\nBcc: everyone@example.com" },
        { ...base, from: "noreply@example.com\nBcc: x@y.z" },
        { ...base, attachments: [{ filename: "a\r\n.pdf", content: "AAAA" }] },
        { ...base, attachments: [{ filename: "a.pdf", content: "not base64!" }] },
        {
          ...base,
          attachments: [{ filename: "big.bin", content: "A".repeat(14_000_000) }],
        },
      ]
    ) {
      assertEquals(await code(rt.call("email.send", refused)), "invalid");
    }
    assertEquals(kept.length, 3);
  } finally {
    await rt.close();
  }
  // A sender that isn't an address is said at start.
  await assertRejects(
    () => start({ adapter: "console", from: "a@example.com", senders: ["billing"] }),
    Error,
    "senders",
  );
});

test("Resend gets where replies go, and the files", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(await new Request(input, init).text()));
    return Response.json({ id: "re_1" });
  }) as typeof globalThis.fetch;
  const rt = await start({
    adapter: "resend",
    from: "App <noreply@example.com>",
    apiKey: "re_k",
    replyTo: "help@example.com",
  }, fetch);
  try {
    const files: EmailAttachment[] = [
      { filename: "nota.pdf", content: base64Of(PDF), contentType: "application/pdf" },
      { filename: "leia.txt", content: btoa("oi") },
    ];
    await rt.call("email.send", { to: "ana@example.com", subject: "Oi", text: "Oi." });
    await rt.call("email.send", {
      to: "ana@example.com",
      subject: "Nota",
      text: "Segue.",
      replyTo: "fin@example.com",
      attachments: files,
    });
    assertEquals(bodies[0].reply_to, "help@example.com");
    assertEquals(bodies[0].attachments, undefined);
    assertEquals(bodies[1].reply_to, "fin@example.com");
    assertEquals(bodies[1].attachments, [
      { filename: "nota.pdf", content: base64Of(PDF), content_type: "application/pdf" },
      { filename: "leia.txt", content: btoa("oi") },
    ]);
  } finally {
    await rt.close();
  }
});

test("MIME: quoted-printable keeps lines under 76 and reads back; a dot that starts a line is doubled", () => {
  const text = `${"ã".repeat(60)} fim \n${"a".repeat(200)}\n\tcom tab no fim\t`;
  const encoded = quotedPrintable(text);
  assert(encoded.split("\r\n").every((line) => line.length <= 76));
  assertEquals(unquoted(encoded), text.replace(/\n/g, "\r\n"));
  assertEquals(stuffed("a\r\n.b\r\n..c"), "a\r\n..b\r\n...c\r\n.\r\n");
});
