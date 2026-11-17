/**
 * The `email` port through a sendmail program (the `sendmail` adapter), with
 * fake ones (scripts in a temp dir): the message on its stdin as MIME, its
 * arguments (no shell), a failure's stderr, a timeout. And inline files
 * (`id`): `multipart/related` with a Content-ID, and Resend's `content_id`.
 * Skipped on Windows, where the fakes are shell scripts.
 */
import { assert, assertEquals, assertMatch, assertRejects, assertThrows } from "@std/assert";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access, email, mime } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

const windows = process.platform === "win32";

async function start(settings: Record<string, unknown>, fetch?: typeof globalThis.fetch) {
  return await createRuntime({
    store: memoryStore(),
    plugins: [...access, email, definePlugin({ name: "app", resources: { email: settings } })],
    ...(fetch ? { fetch } : {}),
  });
}

/** A fake sendmail in a temp dir: `body` is its shell script. */
async function fake(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "sendmail-"));
  const path = join(dir, "sendmail");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return { dir, path, out: join(dir, "out.txt"), args: join(dir, "args.txt") };
}

const KEEPS = (dir: string) =>
  `cat > "${dir}/out.txt"\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${dir}/args.txt"\nexit 0`;

test({
  name: "sendmail: the message goes on stdin, the recipient as an argument, never a shell",
  ignore: windows,
  fn: async () => {
    const dir = await mkdtemp(join(tmpdir(), "sendmail-"));
    const f = await fake(KEEPS(dir));
    const rt = await start({
      adapter: "sendmail",
      from: "Loja <loja@example.com>",
      sendmail: { path: f.path, args: ["-oi"] },
    });
    try {
      const sent = await rt.call<{ id?: string }>("email.send", {
        to: "Ana <ana@example.com>",
        subject: "Olá, nota nº 1",
        text: "Segue.",
      });
      const source = await readFile(join(dir, "out.txt"), "utf8");
      assertMatch(source, /^From: "Loja" <loja@example\.com>\n/);
      assert(source.includes('To: "Ana" <ana@example.com>\n'));
      assert(source.includes(`Message-ID: ${sent.id}\n`));
      assertEquals(
        (await readFile(join(dir, "args.txt"), "utf8")).trim().split("\n"),
        ["-i", "-f", "loja@example.com", "-oi", "--", "ana@example.com"],
      );
    } finally {
      await rt.close();
      await rm(dir, { recursive: true });
      await rm(f.dir, { recursive: true });
    }
  },
});

test({
  name: "sendmail: a non-zero exit says why (stderr, trimmed); a slow program times out",
  ignore: windows,
  fn: async () => {
    const bad = await fake(`cat > /dev/null\necho "  queue full  " >&2\nexit 1`);
    const slow = await fake(`sleep 5`);
    const base = { adapter: "sendmail", from: "loja@example.com" };
    const send = (rt: Awaited<ReturnType<typeof start>>) =>
      rt.call("email.send", { to: "ana@example.com", subject: "Oi", text: "Oi." });
    const logged: string[] = [];
    const log = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    const rt1 = await start({ ...base, sendmail: { path: bad.path } });
    const rt2 = await start({ ...base, sendmail: { path: slow.path, timeout: 200 } });
    const rt3 = await start({ ...base, sendmail: { path: join(bad.dir, "nope") } });
    try {
      for (const rt of [rt1, rt2, rt3]) {
        await assertRejects(() => send(rt), Error, "We couldn't send the email");
      }
      assert(logged[0].includes(`exited 1: queue full`));
      assert(logged[1].includes("didn't finish in 0.2 s"));
      assert(logged[2].includes("nope"));
    } finally {
      console.error = log;
      await rt1.close();
      await rt2.close();
      await rt3.close();
      await rm(bad.dir, { recursive: true });
      await rm(slow.dir, { recursive: true });
    }
  },
});

test({
  name: "sendmail: an address that isn't one never reaches the program",
  ignore: windows,
  fn: async () => {
    const dir = await mkdtemp(join(tmpdir(), "sendmail-"));
    const f = await fake(KEEPS(dir));
    const rt = await start({
      adapter: "sendmail",
      from: "loja@example.com",
      sendmail: { path: f.path },
    });
    try {
      for (const to of ["a b@example.com", "x@example.com;touch pwned"]) {
        await rt.call("email.send", { to, subject: "Oi", text: "Oi." }).then(
          () => assert(false, `${to} went`),
          () => {},
        );
      }
      assertThrows(
        () =>
          mime(
            { to: "a@example.com\r\nBcc: z@example.com", subject: "x", text: "x" },
            "f@example.com",
          ),
        Error,
        "line break",
      );
      assertThrows(
        () =>
          mime(
            { to: "a@example.com", subject: "x\nBcc: z@example.com", text: "x" },
            "f@example.com",
          ),
        Error,
        "line break",
      );
      await assertRejects(() => stat(join(dir, "out.txt")));
    } finally {
      await rt.close();
      await rm(dir, { recursive: true });
      await rm(f.dir, { recursive: true });
    }
  },
});

const LOGO = btoa("\x89PNG-logo-bytes");

test("MIME: an inline file is multipart/related with the HTML, inside the alternatives", () => {
  const { source } = mime({
    to: "a@example.com",
    subject: "Recibo",
    text: "Recibo.",
    html: '<img src="cid:logo">',
    attachments: [
      { filename: "logo.png", content: LOGO, id: "logo" },
      { filename: "nota.pdf", content: btoa("pdf") },
    ],
  }, "f@example.com");
  const order = [...source.matchAll(/Content-Type: ([\w/]+)/g)].map((m) => m[1]);
  assertEquals(order, [
    "multipart/mixed",
    "multipart/alternative",
    "text/plain",
    "multipart/related",
    "text/html",
    "image/png",
    "application/pdf",
  ]);
  assert(source.includes("Content-ID: <logo>\r\n"));
  assert(source.includes('Content-Disposition: inline; filename="logo.png"'));
  assert(source.includes('Content-Disposition: attachment; filename="nota.pdf"'));
  assertThrows(
    () =>
      mime({
        to: "a@example.com",
        subject: "x",
        text: "x",
        attachments: [{ filename: "l.png", content: LOGO, id: "l" }],
      }, "f@example.com"),
    Error,
    "needs an html",
  );
});

test("email.send: an inline file's id is checked, and Resend gets content_id", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(await new Request(input, init).text()));
    return Response.json({ id: "re_1" });
  }) as typeof globalThis.fetch;
  const rt = await start({ adapter: "resend", from: "a@example.com", apiKey: "re_k" }, fetch);
  try {
    const base = { to: "ana@example.com", subject: "Recibo", text: "Recibo." };
    await rt.call("email.send", {
      ...base,
      html: '<img src="cid:logo">',
      attachments: [{ filename: "logo.png", content: LOGO, id: "logo" }],
    });
    assertEquals(bodies[0].attachments, [{
      filename: "logo.png",
      content: LOGO,
      content_id: "logo",
    }]);
    for (
      const attachments of [
        [{ filename: "l.png", content: LOGO, id: "a b" }],
        [{ filename: "l.png", content: LOGO, id: "x>\r\nBcc: z" }],
        [{ filename: "l.png", content: LOGO, id: "logo" }], // no html
      ]
    ) {
      await assertRejects(
        () =>
          rt.call("email.send", {
            ...base,
            html: attachments[0].id === "logo" ? undefined : "<p>x</p>",
            attachments,
          }),
        Error,
      );
    }
  } finally {
    await rt.close();
  }
});
