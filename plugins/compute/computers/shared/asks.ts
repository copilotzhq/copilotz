/** What an agent asks to do, as its person reads it: "run ls", "start npm run dev", "write a.md". */
import type { Approval } from "../collections/approval.ts";
import { nameOf } from "../../../access/spaces/contract.ts";

export const asks = (a: Pick<Approval, "work" | "detail">): string =>
  a.work === "terminal" ? `run ${a.detail}` : a.work === "jobs" ? `start ${a.detail}` : a.detail;

/** Who asks, as the one answering reads it: "assistant", or "assistant (for Bob)". */
export const asker = (
  a: Pick<Approval, "agent" | "for">,
  me: string,
  names: Record<string, string> = {},
): string => a.for && a.for !== me ? `${a.agent} (for ${nameOf(a.for, names)})` : a.agent;
