/** What an agent asks to do, as its person reads it: "run ls", "start npm run dev", "write a.md". */
import type { Approval } from "../collections/approval.ts";

export const asks = (a: Pick<Approval, "work" | "detail">): string =>
  a.work === "terminal" ? `run ${a.detail}` : a.work === "jobs" ? `start ${a.detail}` : a.detail;

/** Who asks, as the one answering reads it: "assistant", or "assistant (for bob)". */
export const asker = (a: Pick<Approval, "agent" | "for">, me: string): string =>
  a.for && a.for !== me ? `${a.agent} (for ${a.for})` : a.agent;
