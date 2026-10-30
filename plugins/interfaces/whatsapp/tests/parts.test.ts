/**
 * WhatsApp's pieces on their own: Markdown as WhatsApp formats it, long
 * text split where a reader would pause, Meta's signature, what a webhook
 * delivery carries, and the commands people type.
 */
import { assert, assertEquals } from "@std/assert";
import { test } from "../../../../testing/mod.ts";
import { LIMIT, split, toWhatsApp } from "../shared/text.ts";
import { same, sign, signed } from "../shared/signature.ts";
import { inboundOf, mediaOf, wordsOf } from "../shared/payload.ts";
import { commandOf, pickSpace } from "../shared/commands.ts";

test("Markdown, as WhatsApp formats it; code as it is", () => {
  assertEquals(
    toWhatsApp("## Plan\n\n**Ship** it *today*, ~~not~~ tomorrow."),
    [
      "*Plan*",
      "",
      "*Ship* it _today_, ~not~ tomorrow.",
    ].join("\n"),
  );
  assertEquals(toWhatsApp("- one\n- two\n  * nested"), "• one\n• two\n  • nested");
  assertEquals(
    toWhatsApp("See [the docs](https://example.com/docs) or https://example.com."),
    "See the docs (https://example.com/docs) or https://example.com.",
  );
  assertEquals(toWhatsApp("[https://a.io](https://a.io)"), "https://a.io");
  assertEquals(toWhatsApp("Use `a*b*c` and **bold**"), "Use `a*b*c` and *bold*");
  assertEquals(
    toWhatsApp("Run:\n\n```sh\nls **/*.ts\n```\n\nDone."),
    "Run:\n\n```\nls **/*.ts\n```\n\nDone.",
  );
  assertEquals(toWhatsApp("a\n\n---\n\nb"), "a\n\nb");
  assertEquals(toWhatsApp("2 * 3 * 4 = 24"), "2 * 3 * 4 = 24");
});

test("long text in parts within the limit, cut between paragraphs, lines, sentences, words", () => {
  const paragraph = "word ".repeat(150).trim();
  const parts = split(Array.from({ length: 12 }, () => paragraph).join("\n\n"), 2000);
  assert(parts.every((p) => p.length <= 2000));
  assert(parts.every((p) => p.startsWith("word") && p.endsWith("word")));
  assertEquals(parts.join("\n\n").split("\n\n").length, 12);
  // One long paragraph: at a sentence's end.
  const sentences = "This is a sentence. ".repeat(200);
  const cut = split(sentences, 1000);
  assert(cut.every((p) => p.length <= 1000 && p.endsWith(".")));
  // No pause at all: hard cut, nothing lost.
  const solid = "x".repeat(10_000);
  assertEquals(split(solid, LIMIT).join(""), solid);
  assertEquals(split("short"), ["short"]);
  // Never between the halves of an emoji.
  const emoji = "😀".repeat(3000);
  assert(split(emoji, 1001).every((p) => !/^[\uDC00-\uDFFF]/.test(p)));
});

test("a code block cut in two is closed and opened again", () => {
  const code = "```\n" + Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n```";
  const parts = split(code, 600);
  assert(parts.length > 1);
  for (const part of parts) {
    assert(part.length <= 600);
    assertEquals((part.match(/```/g) ?? []).length % 2, 0, part);
  }
});

test("Meta's signature: the body's HMAC-SHA256 with the app's secret, and nothing else", async () => {
  const body = new TextEncoder().encode('{"entry":[]}');
  const header = await sign("app-secret", body);
  assert(header.startsWith("sha256=") && header.length === 71);
  assert(await signed("app-secret", body, header));
  assert(await signed("app-secret", body, header.toUpperCase().replace("SHA256", "sha256")));
  assert(!await signed("other-secret", body, header));
  assert(!await signed("app-secret", new TextEncoder().encode('{"entry":[1]}'), header));
  assert(!await signed("app-secret", body, undefined));
  assert(!await signed("app-secret", body, "sha1=abc"));
  assert(!await signed("", body, header));
  assert(same("abc", "abc") && !same("abc", "abd") && !same("abc", "abcd"));
});

test("what a delivery carries: each message, its number and its sender's name", () => {
  const delivered = {
    object: "whatsapp_business_account",
    entry: [{
      changes: [
        {
          value: {
            metadata: { phone_number_id: "111" },
            contacts: [{ wa_id: "551", profile: { name: "Ana" } }],
            messages: [
              { id: "m1", from: "551", type: "text", text: { body: "hi" } },
              { id: "bad" },
            ],
          },
        },
        { value: { metadata: { phone_number_id: "111" }, statuses: [{ id: "s1" }] } },
      ],
    }],
  };
  assertEquals(inboundOf(delivered), [{
    phoneId: "111",
    message: { id: "m1", from: "551", type: "text", text: { body: "hi" } },
    name: "Ana",
  }]);
  assertEquals(inboundOf(null), []);
  assertEquals(inboundOf({ entry: "nope" }), []);
  const voice = {
    id: "v",
    from: "1",
    type: "audio",
    audio: { id: "a1", mime_type: "audio/ogg; codecs=opus", voice: true },
  };
  assertEquals(mediaOf(voice), {
    id: "a1",
    type: "audio/ogg; codecs=opus",
    name: "voice-note.ogg",
  });
  const doc = {
    id: "d",
    from: "1",
    type: "document",
    document: { id: "d1", filename: "plan.pdf", caption: "the plan" },
  };
  assertEquals(mediaOf(doc)?.name, "plan.pdf");
  assertEquals(wordsOf(doc), "the plan");
  assertEquals(
    wordsOf({
      id: "l",
      from: "1",
      type: "location",
      location: { latitude: 1.5, longitude: 2, name: "Office" },
    }),
    "📍 Office (1.5, 2)",
  );
  assertEquals(
    wordsOf({
      id: "b",
      from: "1",
      type: "interactive",
      interactive: { button_reply: { title: "Yes" } },
    }),
    "Yes",
  );
});

test("commands: only those there are; spaces by name, any case, or the start of one", () => {
  assertEquals(commandOf("/new"), { name: "new", arg: "" });
  assertEquals(commandOf("  /SPACE  Launch team "), { name: "space", arg: "Launch team" });
  assertEquals(commandOf("/spaces"), { name: "space", arg: "" });
  assertEquals(commandOf("/etc/hosts is broken"), undefined);
  assertEquals(commandOf("hello /new"), undefined);
  const spaces = [
    { _id: "p", name: "Personal", kind: "personal" },
    { _id: "l", name: "Launch", kind: "shared" },
    { _id: "lt", name: "Launch Team", kind: "shared" },
    { _id: "f", name: "Finance", kind: "shared" },
    { _id: "o", name: "Old", kind: "shared", archived: "2026-01-01" },
  ];
  assertEquals(pickSpace(spaces, "launch")?._id, "l");
  assertEquals(pickSpace(spaces, "launch t")?._id, "lt");
  assertEquals(pickSpace(spaces, "fin")?._id, "f");
  assertEquals(pickSpace(spaces, "personal")?._id, "p");
  assertEquals(pickSpace(spaces, "lau"), undefined);
  assertEquals(pickSpace(spaces, "old"), undefined);
});

test("a number as links and words: WhatsApp's link with a code typed in, a code in two groups", async () => {
  const { chatLink, digitsOf, grouped, unreachable } = await import("../views/web/words.ts");
  assertEquals(digitsOf("+1 555-0100"), "15550100");
  assertEquals(chatLink("+1 555-0100"), "https://wa.me/15550100");
  assertEquals(chatLink("+1 555-0100", "482913"), "https://wa.me/15550100?text=482913");
  assertEquals(grouped("482913"), "482 913");
  assert(unreachable("http://127.0.0.1:8803") && unreachable("https://localhost"));
  assert(unreachable("http://example.com") && unreachable("https://192.168.0.2"));
  assert(!unreachable("https://app.example.com"));
});
