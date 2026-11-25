/**
 * The connect flow ("Connect your plans"), as plain functions: the
 * checklist for the ways picked (`linesOf`), and the calls to make next
 * (`nextOf`). The dialog (connect-flow.tsx) makes the calls, keeps what they
 * answered (`Facts`), and draws the lines; nothing here remembers what a
 * record said before, but for an account the person signs in to, which its
 * record says as it changes.
 *
 * The lines, in order: the computer (when a way runs on one: readied by
 * `computer.prepare`: awake, on the app's program, its CLIs as they are
 * now); then, for each way: its CLI installed (only when the check says
 * it's missing: as part of its sign-in), its sign-in, and a test, when the
 * way has a model to try (`llm.test`). Lines that run alone (the computer,
 * tests) start as soon as what they need is done; sign-ins need the person,
 * so one at a time, in order: one on the server can go while the computer
 * wakes. A failure stops only what needs it, and says what fixes it.
 */
import type { Account } from "../../../../access/accounts/contract.ts";
import type { Prepared } from "../../actions/prepare.ts";
import type { Way } from "./plan-states.ts";

/** What a call failed with: its code, and its words. */
export type Failure = { code?: string; message: string };

/** A way's sign-in on its computer (`computer.engine.login`, installing its CLI first if needed). */
export type SignIn =
  | { is: "running"; installing: boolean; url?: string }
  | { is: "done" }
  | { is: "failed"; failure?: Failure; installed?: boolean };

/** A way's test (`llm.test`). */
export type Test =
  | { is: "running" }
  | { is: "done"; text: string }
  | { is: "failed"; failure: Failure };

/** What the flow's calls answered: never what a record remembers. */
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
  /** Each way's sign-in and test, by its provider. */
  signins: Record<string, SignIn>;
  /** The sign-in the person is on: it stays the one that goes until it's done. */
  attending?: string;
  tests: Record<string, Test>;
};

/** What fixes a failed line: a press of one button. */
export type Fix =
  /** Does it again. */
  | "retry"
  /** A cloud computer instead (a laptop that's off). */
  | "cloud"
  /** Makes the computer theirs alone (it's shared with others' agents). */
  | "shared"
  /** Signs in again (the test found it signed out). */
  | "signin"
  /** Its command, to run in the computer's terminal, with the installer's output: a fallback. */
  | "terminal";

/** Why a line failed, for its sentence. */
export type Why =
  | "off"
  | "wake"
  | "shared"
  | "reach"
  | "install"
  | "windows"
  | "signin"
  | "gone"
  | "signedOut"
  | "test";

/** What a done line says beside done. */
export type Note = "old" | "already" | "limit" | "model";

export type LineState =
  | { is: "waiting" }
  | { is: "active" }
  | { is: "done"; note?: Note }
  | {
    is: "failed";
    why: Why;
    fix?: Fix;
    failure?: Failure;
    /** Its computer runs an older program than the app: the sentence says so. */
    old?: boolean;
  };

export type Line = {
  /** `computer`, or `install:`, `signin:`, `test:` and the way's provider. */
  key: string;
  kind: "computer" | "install" | "signin" | "test";
  way?: Way;
  state: LineState;
};

/** Codes that say the plan isn't signed in there (anymore). */
const SIGNED_OUT = ["engine_signed_out", "account_missing", "account_needs_reconnect"];

/** Why the computer couldn't be readied, and what fixes it. */
function computerFailed(failure: Failure, kept?: boolean): LineState {
  if (failure.code === "computer_shared") {
    return { is: "failed", why: "shared", fix: "shared", failure };
  }
  if (failure.code === "offline") {
    return kept
      ? { is: "failed", why: "wake", fix: "retry", failure }
      : { is: "failed", why: "off", fix: "cloud", failure };
  }
  return { is: "failed", why: "reach", fix: "retry", failure };
}

/**
 * The checklist for `ways`, from what the flow's calls answered and the
 * person's accounts. Of the sign-ins that can go, one is active: the one the
 * person is on (`facts.attending`), else the first.
 */
export function linesOf(ways: Way[], facts: Facts, accounts: Account[]): Line[] {
  const lines: Line[] = [];
  const old = !!facts.prepared && !facts.prepared.program.current;
  const failed = (state: Extract<LineState, { is: "failed" }>): LineState =>
    old ? { ...state, old } : state;
  let ready = false;
  if (ways.some((w) => w.engine)) {
    const state: LineState = facts.unprepared
      ? computerFailed(facts.unprepared, facts.kept)
      : facts.prepared
      ? old ? { is: "done", note: "old" } : { is: "done" }
      : facts.computer
      ? { is: "active" }
      : { is: "waiting" };
    ready = state.is === "done";
    lines.push({ key: "computer", kind: "computer", state });
  }
  // Each way's install (if its CLI is missing), and its sign-in as it stands, unless it can go.
  const steps = ways.map((way) => {
    const signin = facts.signins[way.provider];
    if (!way.engine) {
      const account = accounts.find((a) => a.provider === way.account);
      return { way, signin: account?.status === "connected" ? done() : undefined };
    }
    const seen = ready ? facts.prepared!.engines[way.engine] : undefined;
    let install: LineState | undefined;
    if (ready && !seen?.installed) {
      install = facts.os === "win32"
        ? failed({ is: "failed", why: "windows", fix: "terminal" })
        : signin?.is === "failed" && signin.installed === false
        ? failed({ is: "failed", why: "install", fix: "terminal", ...failureOf(signin) })
        : signin?.is === "running" && signin.installing && !signin.url
        ? { is: "active" }
        : (signin && signin.is !== "running") || signin?.url
        ? { is: "done" }
        : { is: "waiting" };
    }
    const state: LineState | undefined = seen?.signedIn && !signin
      ? { is: "done", note: "already" }
      : signin?.is === "done"
      ? done()
      : !ready || install?.is === "failed"
      ? { is: "waiting" }
      : signin?.is === "failed"
      ? failed({
        is: "failed",
        why: signin.failure?.code === "offline" ? "gone" : "signin",
        fix: "retry",
        ...failureOf(signin),
      })
      : undefined;
    return { way, install, signin: state };
  });
  // The sign-in that goes now: under way, or the one the person is on, else the first that can.
  const can = steps.filter((s) => !s.signin).map((s) => s.way.provider);
  const going = steps.find((s) => facts.signins[s.way.provider]?.is === "running")?.way.provider ??
    (facts.attending && can.includes(facts.attending) ? facts.attending : can[0]);
  for (const { way, install, signin } of steps) {
    if (install) {
      lines.push({ key: `install:${way.provider}`, kind: "install", way, state: install });
    }
    const state: LineState = signin ??
      (way.provider === going ? { is: "active" } : { is: "waiting" });
    lines.push({ key: `signin:${way.provider}`, kind: "signin", way, state });
    if (!way.model) continue;
    const test = facts.tests[way.provider];
    lines.push({
      key: `test:${way.provider}`,
      kind: "test",
      way,
      state: state.is !== "done"
        ? { is: "waiting" }
        : !test || test.is === "running"
        ? { is: "active" }
        : test.is === "done"
        ? { is: "done" }
        : test.failure.code === "engine_limit"
        ? { is: "done", note: "limit" }
        : test.failure.code === "engine_model"
        ? { is: "done", note: "model" }
        : SIGNED_OUT.includes(test.failure.code ?? "")
        ? failed({ is: "failed", why: "signedOut", fix: "signin", failure: test.failure })
        : failed({ is: "failed", why: "test", fix: "retry", failure: test.failure }),
    });
  }
  return lines;
}

const done = (): LineState => ({ is: "done" });

const failureOf = (signin: Extract<SignIn, { is: "failed" }>) =>
  signin.failure ? { failure: signin.failure } : {};

/** A call the flow makes next: readying the computer, a way's sign-in on it, or a test. */
export type Next =
  | { call: "prepare"; computer: string }
  | { call: "signin"; way: Way; computer: string; install: boolean }
  | { call: "test"; way: Way };

/** The calls to start now: those an active line needs that aren't under way or answered. */
export function nextOf(lines: Line[], facts: Facts): Next[] {
  const next: Next[] = [];
  for (const line of lines) {
    if (line.state.is !== "active") continue;
    if (line.kind === "computer" && facts.computer && !facts.preparing) {
      next.push({ call: "prepare", computer: facts.computer });
    }
    const way = line.way;
    if (line.kind === "signin" && way?.engine && !facts.signins[way.provider] && facts.computer) {
      const install = lines.some((l) => l.key === `install:${way.provider}`);
      next.push({ call: "signin", way, computer: facts.computer, install });
    }
    if (line.kind === "test" && way && !facts.tests[way.provider]) next.push({ call: "test", way });
  }
  return next;
}

/** Whether the flow is over (nothing active: each line done, failed, or waiting on one that failed). */
export const finished = (lines: Line[]): boolean =>
  lines.length > 0 && !lines.some((l) => l.state.is === "active");

/** The ways the flow connected: their sign-in done, and their test (if any) not failed. */
export const connected = (lines: Line[]): Way[] =>
  lines.flatMap((l) =>
    l.kind === "signin" && l.state.is === "done" && l.way &&
      !lines.some((t) => t.key === `test:${l.way!.provider}` && t.state.is === "failed")
      ? [l.way]
      : []
  );

/**
 * What a fix forgets, so the line runs again: the computer's readiness
 * (`retry` on it, or `signin`: the CLIs are asked again), a way's sign-in,
 * or its test.
 */
export function forget(facts: Facts, line: Line): Facts {
  const signins = { ...facts.signins };
  const tests = { ...facts.tests };
  const provider = line.way?.provider;
  if (line.kind === "computer" || line.state.is === "failed" && line.state.fix === "signin") {
    const { prepared: _p, unprepared: _u, ...rest } = facts;
    if (provider) {
      delete signins[provider];
      delete tests[provider];
    }
    return { ...rest, signins, tests };
  }
  if (provider && (line.kind === "signin" || line.kind === "install")) delete signins[provider];
  if (provider && line.kind === "install") {
    // Installed from its terminal: asked again, as the computer is now.
    const { prepared: _p, ...rest } = facts;
    return { ...rest, signins, tests };
  }
  if (provider && line.kind === "test") delete tests[provider];
  return { ...facts, signins, tests };
}
