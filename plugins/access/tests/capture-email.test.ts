import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRuntime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { tempDir, test } from "../../../testing/mod.ts";
import { captureEmail, email } from "../email/mod.ts";

test("email.send captures the delivered message and can save its MIME source", async () => {
  const directory = tempDir();
  const inbox = captureEmail({ directory });
  const other = captureEmail();
  const settings = { adapter: "capture", from: "orders@example.com", replyTo: "help@example.com" };
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [email, {
      name: "mail-test",
      resources: { email: settings },
      adapters: { email: { capture: inbox } },
    }],
  });
  try {
    const message = {
      to: "ana@example.com",
      subject: "Invoice 42",
      text: "Your invoice.",
      html: "<p>Your invoice.</p>",
      attachments: [{ filename: "invoice.txt", content: "NDI=" }],
    };
    await runtime.call("email.send", message);
    assertEquals(inbox.messages, [{ ...message, from: settings.from, replyTo: settings.replyTo }]);
    assertEquals(other.messages, []);
    const [file] = await readdir(directory);
    assertEquals(file.endsWith(".eml"), true);
    const source = await readFile(join(directory, file), "utf8");
    for (
      const part of [
        "To: ana@example.com",
        "Subject: Invoice 42",
        "text/html",
        'filename="invoice.txt"',
        "NDI=",
      ]
    ) {
      assertStringIncludes(source, part);
    }
    inbox.clear();
    assertEquals(inbox.messages, []);
    assertEquals(await readdir(directory), [file]);
  } finally {
    await runtime.close();
  }
});

test("the email resource alone can select capture and its directory", async () => {
  const directory = tempDir();
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [email, {
      name: "development",
      resources: {
        email: { adapter: "capture", from: "billing@example.com", capture: { directory } },
      },
    }],
  });
  try {
    await runtime.call("email.send", {
      to: "ana@example.com",
      subject: "Order 5",
      text: "Placed.",
    });
    const [file] = await readdir(directory);
    assertStringIncludes(await readFile(join(directory, file), "utf8"), "Subject: Order 5");
  } finally {
    await runtime.close();
  }
});

test("capture on a public origin needs an explicit test opt-in", async () => {
  const start = (allowPublicOrigin?: boolean) =>
    createRuntime({
      store: memoryStore(),
      plugins: [email, {
        name: "test-mail",
        resources: {
          links: { origin: "https://mail.example.com" },
          email: { adapter: "capture", capture: { allowPublicOrigin } },
        },
      }],
    });
  await assertRejects(async () => (await start()).close(), Error, "capture");
  await (await start(true)).close();
});
