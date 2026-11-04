/**
 * The WhatsApp medium's toolkit on its own: each of Meta's limits, at the
 * edge and past it, ids that repeat, carousel cards that differ; and text
 * joining the part after it, as one message, when there's room.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { test } from "../../../../testing/mod.ts";
import {
  buttons,
  carousel,
  type Choice,
  clip,
  document,
  image,
  list,
  text,
  type WaPart,
} from "../contract.ts";
import { joined } from "../shared/parts.ts";

const x = (n: number) => "x".repeat(n);
const choice = (id: string, title = "Choose"): Choice => ({ id, title });
const card = (id: string, more: Partial<{ body: string; replies: number }> = {}) => ({
  image: { link: `https://example.com/${id}.png` },
  ...(more.body !== undefined ? { body: more.body } : {}),
  buttons: Array.from({ length: more.replies ?? 1 }, (_, i) => choice(`${id}.${i}`)),
});
const refused = (fn: () => unknown, says: string) => assertThrows(fn, Error, says);

test("text: up to 4096 characters, never empty", () => {
  assertEquals(text(x(4096)), { type: "text", text: x(4096) });
  refused(() => text(x(4097)), "at most 4096");
  refused(() => text("  "), "empty");
});

test("buttons: 1 to 3, titles of 20, ids of 256 and each its own; body 1024; header and footer 60", () => {
  const three = [choice("a", x(20)), choice("b"), choice(x(256))];
  assertEquals(
    (buttons(x(1024), three, { header: x(60), footer: x(60) }) as { buttons: Choice[] })
      .buttons.length,
    3,
  );
  refused(() => buttons("Pay?", []), "1 to 3");
  refused(() => buttons("Pay?", [...three, choice("d")]), "1 to 3");
  refused(() => buttons("Pay?", [choice("a", x(21))]), "at most 20");
  refused(() => buttons("Pay?", [choice(x(257))]), "at most 256");
  refused(() => buttons("Pay?", [choice("a"), choice("a")]), "used twice");
  refused(() => buttons(x(1025), [choice("a")]), "at most 1024");
  refused(() => buttons("Pay?", [choice("a")], { footer: x(61) }), "at most 60");
  refused(
    () => buttons("Pay?", [choice("a")], { header: { link: "http://plain.example" } }),
    "https",
  );
  buttons("Pay?", [choice("a")], { header: { link: "https://example.com/qr.png" } });
});

test("list: a button of 20, 1 to 10 rows in all, rows of 24 and 72, ids of 200, sections titled", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: `r${i}`,
    title: x(24),
    description: x(72),
  }));
  list(x(4096), x(20), [{ title: "Morning", rows: rows.slice(0, 5) }, {
    title: "Evening",
    rows: rows.slice(5),
  }]);
  refused(
    () => list("Trips", "See", [{ rows: [...rows, { id: "r10", title: "one more" }] }]),
    "1 to 10 rows",
  );
  refused(() => list("Trips", x(21), [{ rows }]), "at most 20");
  refused(() => list("Trips", "See", [{ rows: [{ id: "a", title: x(25) }] }]), "at most 24");
  refused(
    () => list("Trips", "See", [{ rows: [{ id: "a", title: "A", description: x(73) }] }]),
    "at most 72",
  );
  refused(() => list("Trips", "See", [{ rows: [{ id: x(201), title: "A" }] }]), "at most 200");
  refused(
    () => list("Trips", "See", [{ rows: [{ id: "a", title: "A" }, { id: "a", title: "B" }] }]),
    "used twice",
  );
  refused(
    () => list("Trips", "See", [{ rows: [rows[0]] }, { title: "B", rows: [rows[1]] }]),
    "titles each",
  );
  refused(() => list("Trips", "See", [{ title: x(25), rows: [rows[0]] }]), "at most 24");
});

test("carousel: 2 to 10 cards, each a public picture, short text, as many quick replies", () => {
  const ten = Array.from({ length: 10 }, (_, i) => card(`t${i}`, { body: `${x(150)}\na\nb` }));
  assertEquals((carousel(x(1024), ten) as { cards: unknown[] }).cards.length, 10);
  refused(() => carousel("Trips", [card("a")]), "2 to 10");
  refused(() => carousel("Trips", [...ten, card("t10")]), "2 to 10");
  refused(() => carousel(x(1025), [card("a"), card("b")]), "at most 1024");
  refused(() => carousel("Trips", [card("a", { body: x(161) }), card("b")]), "at most 160");
  refused(() => carousel("Trips", [card("a", { body: "1\n2\n3\n4" }), card("b")]), "over 2 breaks");
  refused(() => carousel("Trips", [card("a", { replies: 2 }), card("b")]), "as many quick replies");
  refused(
    () => carousel("Trips", [card("a", { replies: 4 }), card("b", { replies: 4 })]),
    "1 to 3",
  );
  refused(
    () =>
      carousel("Trips", [
        { ...card("a"), image: { link: "http://plain.example/a.png" } },
        card("b"),
      ]),
    "https",
  );
  refused(
    () => carousel("Trips", [card("a"), { ...card("b"), buttons: [choice("a.0")] }]),
    "used twice",
  );
});

test("images and documents: captions of 1024, a document's name", () => {
  image({ link: "https://example.com/qr.png" }, x(1024));
  refused(() => image({ link: "https://example.com/qr.png" }, x(1025)), "at most 1024");
  document({ link: "https://example.com/ticket.pdf" }, "ticket.pdf", "Your ticket");
  refused(() => document({ link: "https://example.com/t.pdf" }, ""), "empty");
});

test("clip cuts a title on purpose; text joins the part after it when there's room", () => {
  assertEquals(clip("Expresso do Sul, 10:30", 20), "Expresso do Sul, 10…");
  assertEquals(clip("Short", 20), "Short");
  const pay = buttons("Pay how?", [choice("pix", "PIX")]);
  assertEquals((joined("Found it.", pay) as { text: string }).text, "Found it.\n\nPay how?");
  assertEquals(joined(x(1020), pay), undefined);
  const qr = image({ link: "https://example.com/qr.png" });
  assertEquals((joined("Scan this:", qr) as { caption: string }).caption, "Scan this:");
  assertEquals((joined("a", text("b")) as WaPart & { text: string }).text, "a\n\nb");
});
