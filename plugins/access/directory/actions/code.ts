/**
 * Gift codes (see collections/credit-code.ts). All the system's: staff ask
 * through the console, orgs through their `directory` resource. None is
 * recorded, so a code is in no event.
 *
 * - `code.create` `{ amount, expires?, until?, note?, by }`: a new code, shown
 *   this once;
 * - `code.claim` `{ code, org, person }`: its credits, for that org. Claimed
 *   already by the same org, it answers the same, so a grant that failed can be
 *   tried again; by another, it's refused;
 * - `code.list` `{}`, newest first, and `code.revoke` `{ id }`, while unclaimed.
 */
import { defineAction, failure, invalid } from "../../../../runtime/mod.ts";
import type { CreditCode } from "../collections/credit-code.ts";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 130 random bits, as people can read and type them. */
function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  const chars = [...bytes].map((byte) => ALPHABET[byte % 32]).join("");
  return `GIFT-${chars.match(/.{1,5}/g)!.join("-")}`;
}

/** How it's kept: typed in any case, with or without its dashes. */
async function hashOf(code: string): Promise<string> {
  const plain = code.toUpperCase().replace(/[^0-9A-Z]/g, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const shown = (doc: CreditCode) => ({
  id: doc._id,
  // Enough to tell them apart: it can't be claimed with this.
  short: doc._id.slice(0, 8),
  amount: doc.amount,
  ...(doc.expires ? { expires: doc.expires } : {}),
  ...(doc.until ? { until: doc.until } : {}),
  ...(doc.note ? { note: doc.note } : {}),
  by: doc.by,
  at: doc.at,
  ...(doc.org ? { org: doc.org, person: doc.person, claimed: doc.claimed } : {}),
  ...(doc.revoked ? { revoked: doc.revoked } : {}),
});

export const createCodeAction = defineAction({
  description: "Makes a gift code of credits; it's shown this once",
  record: false,
  input: {
    type: "object",
    properties: {
      amount: { type: "number", exclusiveMinimum: 0 },
      expires: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      until: { type: "string" },
      note: { type: "string", maxLength: 200 },
      by: { type: "string" },
    },
    required: ["amount", "by"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const code = newCode();
    const _id = await hashOf(code);
    await ctx.db.collection<CreditCode>("creditCode").insertOne({
      _id,
      ...input,
      at: new Date().toISOString(),
    } as CreditCode);
    return { code, id: _id };
  },
});

export const claimCodeAction = defineAction({
  description: "Claims a gift code for an org",
  record: false,
  input: {
    type: "object",
    properties: {
      code: { type: "string" },
      org: { type: "string" },
      person: { type: "string" },
    },
    required: ["code", "org", "person"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const codes = ctx.db.collection<CreditCode>("creditCode");
    const _id = await hashOf(input.code);
    const invalidCode = () =>
      failure("invalid_code", "That code isn't valid. Check it and try again.");
    const answer = (doc: CreditCode) => ({
      id: _id.slice(0, 16),
      amount: doc.amount,
      ...(doc.expires ? { expires: doc.expires } : {}),
      ...(doc.note ? { note: doc.note } : {}),
    });
    const doc = await codes.findOne({ _id });
    if (!doc || doc.revoked) throw invalidCode();
    if (doc.org === input.org) return answer(doc);
    if (doc.org) throw failure("used_code", "That code has already been used.");
    const now = new Date().toISOString();
    if (doc.until && doc.until <= now) throw failure("expired_code", "That code has expired.");
    // One writer: only one claim finds it unclaimed.
    const { modifiedCount } = await codes.updateOne(
      { _id, org: { $exists: false }, revoked: { $exists: false } },
      { $set: { org: input.org, person: input.person, claimed: now } },
    );
    if (modifiedCount) return answer(doc);
    const now2 = await codes.findOne({ _id });
    if (now2?.org === input.org) return answer(now2);
    throw failure("used_code", "That code has already been used.");
  },
});

export const listCodesAction = defineAction({
  description: "Gift codes, newest first",
  record: false,
  input: { type: "object", additionalProperties: false },
  run: async (ctx) => ({
    codes: (await ctx.db.collection<CreditCode>("creditCode").find({}, {
      sort: { at: -1 },
      limit: 200,
    })).map(shown),
  }),
});

export const revokeCodeAction = defineAction({
  description: "Takes back a gift code nobody has claimed",
  record: false,
  input: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const { modifiedCount } = await ctx.db.collection<CreditCode>("creditCode").updateOne(
      { _id: input.id, org: { $exists: false } },
      { $set: { revoked: new Date().toISOString() } },
    );
    if (!modifiedCount) throw invalid("It's been claimed, or there's no such code.");
    return {};
  },
});
