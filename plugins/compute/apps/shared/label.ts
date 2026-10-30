/**
 * An app's label, its host's first part (`<label>.copilotz.app`): its name
 * as a DNS label (lowercase letters, digits and hyphens, starting with a
 * letter, at most 40 characters), unique among the app's apps and, through
 * the directory, every org's. A label that's taken gets a short suffix
 * (`shop-x7k2`). Some are kept for the front itself, and none ends in
 * `-preview`, which previews' hosts do.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { AppDoc } from "../collections/app.ts";
import { claim } from "./claims.ts";
import { failure } from "./errors.ts";

export const MAX_LABEL = 40;

const KEPT = new Set([
  "www",
  "app",
  "api",
  "compass",
  "admin",
  "preview",
  "previews",
  "static",
  "assets",
  "status",
  "docs",
  "mail",
]);

/** Whether a label is kept for the front, or looks like a preview's. */
export const kept = (label: string): boolean => KEPT.has(label) || label.endsWith("-preview");

/** A name as a label: "Café Shop!" is `cafe-shop`; one starting with a digit starts with `app-`. */
export function slugOf(name: string): string {
  const slug = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const lettered = /^[a-z]/.test(slug) ? slug : `app-${slug}`;
  return lettered.slice(0, MAX_LABEL).replace(/-+$/, "");
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A label with a short random suffix, still at most 40 characters. */
export function suffixed(label: string): string {
  const random = crypto.getRandomValues(new Uint8Array(4));
  const suffix = [...random].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${label.slice(0, MAX_LABEL - 5).replace(/-+$/, "")}-${suffix}`;
}

/**
 * A free label for `name`, claimed at the directory (with no target yet):
 * its slug, else the slug with a suffix, tried a few times.
 */
export async function claimLabel(ctx: Context, name: string, domain: string): Promise<string> {
  const apps = ctx.as().db.collection<AppDoc>("app");
  const base = slugOf(name);
  for (let attempt = 0; attempt < 8; attempt++) {
    const label = attempt === 0 ? base : suffixed(base);
    if (kept(label)) continue;
    if (await apps.findOne({ label, status: { $ne: "removed" } })) continue;
    if (await claim(ctx, `${label}.${domain}`)) return label;
  }
  throw failure(`Couldn't find a free address for "${name}": try another name.`, "taken");
}
