/**
 * What WhatsApp offers in the command palette (kind `whatsapp.palette`, the
 * web shell's `palette` resource): in a space, its WhatsApp tab, said as
 * what's to do there: linking your phone when the space has a number you
 * haven't, connecting one when it has none.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { PaletteGroup } from "../../../../../hosts/web/mod.ts";
import type { WhatsAppNumber, WhatsAppPhone } from "../../contract.ts";

export const whatsappPaletteView = (
  _: unknown,
  ctx: ViewContext<ReactNode>,
): PaletteGroup[] | null => {
  const here = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  if (!here) return null;
  const numbers = ctx.db.collection<WhatsAppNumber>("whatsapp_number").find({ in: here }).value;
  const phones = ctx.db.collection<WhatsAppPhone>("whatsapp_phone").find({}).value;
  if (!numbers || !phones) return null;
  const unlinked = numbers.some((n) => !phones.some((p) => p.number === n._id));
  return [{
    title: "This space",
    order: 10,
    items: [{
      key: "whatsapp",
      label: !numbers.length
        ? "Connect a WhatsApp number"
        : unlinked
        ? "Link your phone to WhatsApp"
        : "WhatsApp",
      description: numbers.length ? numbers.map((n) => n.phone).join(", ") : undefined,
      icon: "chat",
      keywords: ["whatsapp", "phone", "mobile", "message", "link", "number"],
      href: `/space/${encodeURIComponent(here)}?tab=whatsapp`,
    }],
  }];
};
