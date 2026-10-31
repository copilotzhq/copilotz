/**
 * What agents wait on their person for, just above where they type (the
 * shell's `notices`): each request, and how to answer it. Live: it's there
 * when an agent asks, and gone once answered.
 */
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { accent, bold, dim } from "../../../../../hosts/terminal/mod.ts";
import type { Approval } from "../../collections/approval.ts";
import { asker, asks } from "../../shared/asks.ts";
import { namesIn } from "../../../../access/spaces/contract.ts";

export const approvalsView = (item: { person: string }, ctx: ViewContext): string | undefined => {
  const waiting = ctx.db.collection<Approval>("approval").query<Approval[]>("pending", {});
  if (waiting.status !== "ready" || !waiting.value.length) return undefined;
  const many = waiting.value.length > 1;
  const names = namesIn(ctx, waiting.value.flatMap((a) => a.for ? [a.for] : []));
  return [
    ...waiting.value.map((a, i) =>
      `${accent("?")} ${many ? dim(`[${i + 1}] `) : ""}${asker(a, item.person, names)} wants to ${
        bold(asks(a))
      }${a.name ? dim(` on ${a.name}`) : ""}`
    ),
    dim(
      many
        ? "  /approve <n> once · thread (this conversation) · always · no"
        : "  /approve once · /approve thread (this conversation) · /approve always · /approve no",
    ),
  ].join("\n");
};
