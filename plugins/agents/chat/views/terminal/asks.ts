/**
 * What agents wait on their person for, just above where they type (the
 * shell's `notices`, kind `approvals`): each ask, and how to answer it, with
 * only the answers it takes. A share says who'd see it, and what it would
 * say. Live: it's there when an agent asks, and gone once answered. What it
 * says is in chat's words, as the web's cards say it; the commands, as typed.
 */
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { accent, bold, dim } from "../../../../../hosts/terminal/mod.ts";
import { namesIn } from "../../../../access/spaces/contract.ts";
import type { Approval } from "../../collections/approval.ts";
import { asker, asking, seenOf, TYPED } from "../asked.ts";
import { say } from "../web/words.ts";

/** How to answer: `/approve once · /approve thread (this conversation) · …`, or by number. */
export function howTo(a: Pick<Approval, "answers">, n?: number): string {
  const typed = a.answers.map((answer) => TYPED[answer]);
  return n === undefined
    ? typed.map((t) => `/approve ${t.word}${t.note ? ` (${t.note})` : ""}`).join(" · ")
    : `/approve ${n} ${typed.map((t) => t.word).join(" · ")}`;
}

/** What else an ask says, under it: who'd see a share, and what it would say. */
function about(a: Approval): string[] {
  const seen = seenOf(a);
  const preview = a.preview?.split("\n")[0]?.slice(0, 120);
  return [
    ...(seen ? [`  ${dim(seen)}`] : []),
    ...(preview && a.work !== "terminal" && a.work !== "jobs" ? [`  ${dim(`“${preview}”`)}`] : []),
  ];
}

export const approvalsView = (item: { person: string }, ctx: ViewContext): string | undefined => {
  const waiting = ctx.db.collection<Approval>("approval").query<Approval[]>("pending", {});
  if (waiting.status !== "ready" || !waiting.value.length) return undefined;
  const many = waiting.value.length > 1;
  const names = namesIn(ctx, waiting.value.flatMap((a) => a.for ? [a.for] : []));
  return [
    ...waiting.value.flatMap((a, i) => [
      `${accent("?")} ${many ? dim(`[${i + 1}] `) : ""}${
        say("wantsTo", { agent: asker(a, item.person, names), doing: bold(asking(a)) })
      }`,
      ...about(a),
      ...(many ? [] : [dim(`  ${howTo(a)}`)]),
    ]),
    ...(many ? [dim("  /approvals lists them; /approve <n> <answer> answers one")] : []),
  ].join("\n");
};
