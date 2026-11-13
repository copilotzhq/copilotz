/**
 * A share: an agent's tool writing somewhere whose readers don't all reach
 * what its work may read (a Personal space's agent posting in Launch, a
 * team's answering into a customer's chat). The access plugin refuses it
 * (`needs_approval`, saying where, to how many, and what it would say), and
 * the turn asks the person the agent works for, as it asks anything else
 * (asks.ts): yes this once, for this conversation, for the routine that set
 * it going, or no; never always, since a place's people change. On a yes the
 * call runs again, its agent's work carrying that place as approved.
 */
import type { Beyond } from "../../../access/spaces/contract.ts";
import type { Answer } from "../collections/approval.ts";
import type { Ask } from "./asks.ts";
import type { Origin } from "./origin.ts";

/** An ask about a share (`approval.work`). */
export const SHARE = "share";

/** What a share's refusal says: where it would show (`to`), as people say it, and what it'd say. */
export type Refused = { to: string; named?: string; preview?: string };

/** The share a refusal asks about, if it's one (`needs_approval`, saying where). */
export function refusedShare(error: unknown): Refused | undefined {
  const e = error as { code?: unknown; to?: unknown; named?: unknown; preview?: unknown } | null;
  if (e?.code !== "needs_approval" || typeof e.to !== "string") return undefined;
  return {
    to: e.to,
    ...(typeof e.named === "string" ? { named: e.named } : {}),
    ...(typeof e.preview === "string" ? { preview: e.preview } : {}),
  };
}

/** The most of what it would say an ask shows. */
const PREVIEW = 280;

/**
 * What a call would write, shortly, from its input, when its refusal
 * doesn't say: its first text, title or body (a post's words).
 */
export function previewOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const fields = input as Record<string, unknown>;
  const said = ["text", "title", "body", "content", "message", "name"]
    .map((field) => fields[field])
    .find((value) => typeof value === "string" && value.trim());
  if (typeof said !== "string") return undefined;
  const text = said.trim();
  return text.length > PREVIEW ? `${text.slice(0, PREVIEW - 1).trimEnd()}…` : text;
}

/** A share, as its person is asked about it: where, who'd see it there, and what it would say. */
export type Share = Beyond & { preview?: string };

/** Who'd see it, as its person is told: "Its 12 members will see it." */
export function seenBy(share: Pick<Share, "people" | "contacts">): string {
  if (share.contacts || !share.people) return "";
  return share.people === 1
    ? "Its one member will see it."
    : `Its ${share.people} members will see it.`;
}

/** What a share does, as people say it: "post this to Launch", "send this to Maria". */
export const sharing = (share: Pick<Share, "named" | "contacts">) =>
  share.contacts ? `send this to ${share.named}` : `post this to ${share.named}`;

/**
 * The ask a share makes of the person an agent works for (`person`), in its
 * turn's thread: where (`on`, `name`) and to how many (`people`), which views
 * say in the reader's words; what the agent is told, in English.
 */
export function shareAsk(
  share: Share,
  at: { person: string; agent: string; thread: string; in?: string; origin?: Origin },
): Ask {
  const doing = sharing(share);
  const seen = seenBy(share);
  const answers: Answer[] = ["once", "thread", ...(at.origin ? ["origin" as const] : []), "deny"];
  return {
    owner: at.person,
    for: at.person,
    agent: at.agent,
    thread: at.thread,
    ...(at.in ? { in: at.in } : {}),
    work: SHARE,
    on: share.to,
    detail: share.named,
    name: share.named,
    people: share.people,
    ...(share.preview ? { preview: share.preview } : {}),
    answers,
    doing,
    question: `May I ${doing}?${seen ? ` ${seen}` : ""}`,
  };
}
