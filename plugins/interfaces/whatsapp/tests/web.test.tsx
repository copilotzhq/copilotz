/**
 * A space's WhatsApp tab, as React draws it: those who manage the space are
 * offered to open its number to customers, and, open, choose who answers and
 * after how long a quiet chat is over; everyone else is told it's open.
 */
import { assert, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Reached } from "../../../access/spaces/contract.ts";
import type { WhatsAppNumber } from "../contract.ts";
import { whatsappView } from "../views/web/space.tsx";
import { test } from "../../../../testing/mod.ts";

const space = (can: Reached["can"]): Reached =>
  ({ _id: "shop", name: "Shop", kind: "shared", at: "2026-11-03T09:00:00.000Z", can }) as Reached;

const number = (more: Partial<WhatsAppNumber> = {}): WhatsAppNumber => ({
  _id: "n1",
  in: "shop",
  phoneId: "1065",
  phone: "+1 555-0100",
  name: "Shop Support",
  at: "2026-11-03T09:00:00.000Z",
  ...more,
});

/** The tab over fixed reads, as someone who may do `can` in the shop. */
const tab = (can: Reached["can"], numbers: WhatsAppNumber[]) => {
  const reads: Record<string, unknown> = {
    whatsapp_number: numbers,
    whatsapp_phone: [],
    whatsapp_code: [],
    "space.reached": [space(can)],
    "thread.agents": {
      here: ["lead", "desk"],
      default: ["lead"],
      agents: { lead: { name: "Lead" }, desk: { name: "Front desk" } },
    },
  };
  const ctx = {
    db: {
      collection: (name: string) => ({
        query: (query: string) => ({ status: "ready", value: reads[`${name}.${query}`] }),
        find: () => ({ status: "ready", value: reads[name] ?? [] }),
      }),
    },
    resources: {},
    renderer: "web",
    kind: "whatsapp.space",
    viewer: { name: "ana" },
    hints: {},
    show: () => null,
    call: () => Promise.resolve({}),
    emit: () => Promise.resolve(),
  } as unknown as ViewContext<ReactNode>;
  return renderToStaticMarkup(<>{whatsappView({ _id: "shop" }, ctx)}</>)
    .replace(/<style[\s\S]*?<\/style>/g, "");
};

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

test("those who manage the space are offered to open its number to customers", () => {
  const shown = text(tab(["read", "write", "manage"], [number()]));
  assertStringIncludes(shown, "Open it to customers");
  assertStringIncludes(shown, "Anyone who writes gets a chat of their own in Shop");
  assert(!shown.includes("Open to customers Anyone can write"), shown);
});

test("open, its managers choose who answers and when a quiet chat is over", () => {
  const html = tab(["read", "write", "manage"], [number({ open: true, agent: "desk", gap: 24 })]);
  const shown = text(html);
  assertStringIncludes(shown, "Open to customers");
  assertStringIncludes(shown, "Answered by");
  assertStringIncludes(shown, "Lead, who answers new chats here");
  assertStringIncludes(html, '<option value="desk" selected="">Front desk</option>');
  assertStringIncludes(html, '<option value="24" selected="">1 day of quiet</option>');
  assertStringIncludes(shown, "12 hours of quiet (default)");
  assertStringIncludes(shown, "Close to customers");
});

test("everyone else is told it's open, and who answers; closed, nothing about customers", () => {
  const open = text(tab(["read", "write"], [number({ open: true, agent: "desk" })]));
  assertStringIncludes(open, "Anyone can write to this number");
  assertStringIncludes(open, "answered by Front desk");
  assert(!open.includes("Close to customers"), open);
  const closed = text(tab(["read", "write"], [number()]));
  assert(!closed.includes("customers"), closed);
});
