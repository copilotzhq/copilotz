/**
 * The connect flow ("Connect your plans") as plain functions: its checklist
 * (`linesOf`), from what the flow's calls answered (`Facts`), and the calls
 * to make next (`nextOf`). The dialog (connect-flow.tsx) makes the calls and
 * draws the lines. Nothing here remembers what a record said, but whether
 * an account is connected, which its record says as it changes.
 *
 * The lines: the computer, when a plan runs through an app on one (readied
 * by `computer.prepare`: awake, on the app's program, its CLIs as they are
 * now); then one line per plan, through its phases: its CLI installed (as
 * part of its sign-in, only when the check says it's missing), signed in
 * (its CLI's sign-in, or on the server the account's own), and a short test
 * answered on it (`llm.test`). Plans go one at a time, in order: the first
 * not over that can go (one on the server doesn't wait for the computer).
 * A failure stops only its own line; Try again checks the computer again
 * and runs the line again (`retry`).
 */
import type { Account } from "../../../../access/accounts/contract.ts";
import type { Prepared } from "../../actions/prepare.ts";
import type { Way } from "./plan-states.ts";

/** What a call failed with: its code, and its words. */
export type Failure = { code?: string; message: string };

/** How far a plan has gone, as the flow's calls answered. */
export type Progress = {
  /** Its CLI's sign-in: under way (installing first, its link once it gives one), done, or failed. */
  signin?: "running" | "done" | "failed";
  installing?: boolean;
  url?: string;
  /** A sign-in that's over: whether its CLI is there (not, when its installer failed). */
  installed?: boolean;
  /** Its test: under way, answered, or failed. */
  test?: "running" | "done" | "failed";
  answer?: string;
  failure?: Failure;
};

/** What the flow's calls answered. */
export type Facts = {
  /** The computer the flow readies, once there's one (the person's best, or one just made). */
  computer?: string;
  /** Its system, as it said (`win32`: a CLI is installed from its terminal). */
  os?: string;
  /** One the app keeps (a cloud computer): it wakes; a laptop is turned on. */
  kept?: boolean;
  preparing?: boolean;
  prepared?: Prepared;
  unprepared?: Failure;
  /** Each plan's progress, by its way's provider. */
  plans: Record<string, Progress>;
};

/** What a plan's line is doing: installing its CLI, signing in, or answering its test. */
export type Phase = "installing" | "signin" | "testing";

/** A line of the checklist: the computer's (`computer`), or a plan's (its way's provider). */
export type Line = {
  key: string;
  way?: Way;
  state: "waiting" | "active" | "done" | "failed";
  /** Active: what it's doing; failed: where it stopped. */
  phase?: Phase;
  /** Done at its limit: connected, and answering again once it resets. */
  limit?: boolean;
  failure?: Failure;
  /** Failed: what fixes it besides Try again: a cloud computer (a laptop that's off), or its command. */
  fix?: "cloud" | "terminal";
};

/** A plan's line as it stands; or `ready` to go, at its turn; or `blocked` on the computer. */
function statusOf(
  way: Way,
  facts: Facts,
  accounts: Account[],
  computer: boolean,
): Line | "ready" | "blocked" {
  const key = way.provider;
  const p = facts.plans[key] ?? {};
  const at = (state: Line["state"], more: Partial<Line> = {}): Line => ({
    key,
    way,
    state,
    ...more,
  });
  const failure = p.failure ? { failure: p.failure } : {};
  if (p.test === "done") return at("done");
  if (p.test === "failed") {
    return p.failure?.code === "engine_limit"
      ? at("done", { limit: true })
      : at("failed", { phase: "testing", ...failure });
  }
  if (p.test === "running") return at("active", { phase: "testing" });
  let signedIn: boolean;
  if (way.engine) {
    if (!computer) return "blocked";
    const seen = facts.prepared!.engines[way.engine];
    // Its installer failed, or can't run here (Windows): its command, as a fallback.
    const install = p.installed === false ||
      (!seen?.installed && !p.signin && facts.os === "win32");
    if (install) return at("failed", { phase: "installing", fix: "terminal", ...failure });
    if (p.signin === "failed") return at("failed", { phase: "signin", ...failure });
    if (p.signin === "running") {
      return at("active", { phase: p.installing && !p.url ? "installing" : "signin" });
    }
    signedIn = p.signin === "done" || (!p.signin && !!seen?.signedIn);
  } else {
    signedIn = accounts.find((a) => a.provider === way.account)?.status === "connected";
  }
  if (signedIn) return way.model ? at("active", { phase: "testing" }) : at("done");
  return "ready";
}

/** The checklist for `ways`, from what the flow's calls answered and the person's accounts. */
export function linesOf(ways: Way[], facts: Facts, accounts: Account[]): Line[] {
  const lines: Line[] = [];
  let computer = false;
  if (ways.some((w) => w.engine)) {
    const f = facts.unprepared;
    const line: Line = f
      ? {
        key: "computer",
        state: "failed",
        failure: f,
        ...(f.code === "offline" && !facts.kept ? { fix: "cloud" as const } : {}),
      }
      : { key: "computer", state: facts.prepared ? "done" : facts.computer ? "active" : "waiting" };
    computer = line.state === "done";
    lines.push(line);
  }
  // One plan at a time: the first under way, or ready to go; the rest wait their turn.
  let turn = false;
  for (const way of ways) {
    const status = statusOf(way, facts, accounts, computer);
    if (status === "blocked" || (turn && (status === "ready" || status.state === "active"))) {
      lines.push({ key: way.provider, way, state: "waiting" });
    } else if (status === "ready") {
      turn = true;
      lines.push({ key: way.provider, way, state: "active", phase: "signin" });
    } else {
      if (status.state === "active") turn = true;
      lines.push(status);
    }
  }
  return lines;
}

/** A call the flow makes next: readying the computer, a plan's CLI signed in on it, or its test. */
export type Next =
  | { call: "prepare"; computer: string }
  | { call: "signin"; way: Way; computer: string; install: boolean }
  | { call: "test"; way: Way };

/** The calls to start now: those an active line needs that aren't under way or answered. */
export function nextOf(lines: Line[], facts: Facts): Next[] {
  const next: Next[] = [];
  for (const { key, way, state, phase } of lines) {
    if (state !== "active") continue;
    if (key === "computer" && facts.computer && !facts.preparing) {
      next.push({ call: "prepare", computer: facts.computer });
    }
    const p = way ? facts.plans[way.provider] ?? {} : {};
    if (way && phase === "testing" && !p.test) next.push({ call: "test", way });
    if (way?.engine && phase === "signin" && !p.signin && facts.computer && facts.prepared) {
      const install = !facts.prepared.engines[way.engine]?.installed;
      next.push({ call: "signin", way, computer: facts.computer, install });
    }
  }
  return next;
}

/** Whether the flow is over: nothing under way (each line done, failed, or waiting on one that failed). */
export const finished = (lines: Line[]): boolean =>
  lines.length > 0 && !lines.some((l) => l.state === "active");

/** The plans it connected. */
export const connected = (lines: Line[]): Way[] =>
  lines.flatMap((l) => l.way && l.state === "done" ? [l.way] : []);

/** Try again: the computer is checked again, and the line runs again, its plan from the start. */
export function retry(facts: Facts, line: Line): Facts {
  const { prepared: _p, unprepared: _u, ...rest } = facts;
  const plans = { ...facts.plans };
  if (line.way) delete plans[line.way.provider];
  return { ...rest, plans };
}
