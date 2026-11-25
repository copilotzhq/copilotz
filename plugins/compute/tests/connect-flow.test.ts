/**
 * The connect flow as a state machine (views/web/connect-lines.ts): from what
 * its calls answered, the checklist (the computer, then one line per plan,
 * through its phases: installing, signing in, testing) and the calls to make
 * next. The founder's test, step by step; every failure, and what fixes it;
 * several plans in one pass, one at a time; and Try again, the one retry.
 */
import { assertEquals } from "@std/assert";
import type { Account } from "../../access/accounts/contract.ts";
import type { Prepared } from "../computers/actions/prepare.ts";
import {
  connected,
  type Facts,
  finished,
  type Line,
  linesOf,
  nextOf,
  retry,
} from "../computers/views/web/connect-lines.ts";
import type { Way } from "../computers/views/web/plan-states.ts";
import { test } from "../../../testing/mod.ts";

const claude: Way = {
  provider: "claude-plan",
  title: "Claude plan",
  plan: "Claude",
  engine: "claude",
  model: "claude-plan/claude-haiku-5-5",
};
const gemini: Way = {
  provider: "gemini-plan",
  title: "Google AI plan",
  plan: "Google AI",
  engine: "antigravity",
};
const chatgpt: Way = {
  provider: "chatgpt",
  title: "ChatGPT",
  plan: "ChatGPT",
  account: "chatgpt",
  model: "chatgpt/gpt-6-luna",
};

const at = "2026-11-25T10:00:00.000Z";
const missing = { installed: false, signedIn: false, at };
const installed = { installed: true, signedIn: false, at };
const prepared = (engines: Prepared["engines"] = {}): Prepared => ({
  computer: "cloud-1",
  online: true,
  shared: false,
  engines,
  program: { version: "1.0.0-rc.66", current: true },
});
const account = (status: Account["status"]): Account => ({
  _id: "a1",
  person: "ana",
  provider: "chatgpt",
  status,
  label: "ana@example.com",
  connected: at,
});

/** Each line as `key state` (and its phase, a limit, or its fix). */
const shown = (lines: Line[]) =>
  lines.map(({ key, state, phase, limit, fix }) =>
    [key, state, phase, limit ? "limit" : undefined, fix].filter(Boolean).join(" ")
  );
const calls = (lines: Line[], facts: Facts) =>
  nextOf(lines, facts).map((n) =>
    n.call === "signin"
      ? `signin ${n.way.provider}${n.install ? " +install" : ""}`
      : n.call === "test"
      ? `test ${n.way.provider}`
      : `prepare ${n.computer}`
  );

test("the founder's test, as the flow runs it: the computer readied, Claude Code installed as it signs in, signed in, answering", () => {
  let facts: Facts = { computer: "cloud-1", kept: true, os: "linux", plans: {} };
  let lines = linesOf([claude], facts, []);
  assertEquals(shown(lines), ["computer active", "claude-plan waiting"]);
  assertEquals(calls(lines, facts), ["prepare cloud-1"]);
  facts = { ...facts, preparing: true };
  assertEquals(calls(linesOf([claude], facts, []), facts), []);

  // computer.prepare woke it, brought it to the release, and asked it: Claude Code is missing.
  facts = { ...facts, preparing: false, prepared: prepared({ claude: missing }) };
  lines = linesOf([claude], facts, []);
  assertEquals(shown(lines), ["computer done", "claude-plan active signin"]);
  // Its sign-in installs it first: nobody is asked to.
  assertEquals(calls(lines, facts), ["signin claude-plan +install"]);

  const running = (more: Facts["plans"][string]) => ({
    ...facts,
    plans: { "claude-plan": { signin: "running" as const, installing: true, ...more } },
  });
  assertEquals(shown(linesOf([claude], running({}), []))[1], "claude-plan active installing");
  assertEquals(
    shown(linesOf([claude], running({ url: "https://claude.ai/x" }), []))[1],
    "claude-plan active signin",
  );

  facts = { ...facts, plans: { "claude-plan": { signin: "done", installed: true } } };
  lines = linesOf([claude], facts, []);
  assertEquals(shown(lines)[1], "claude-plan active testing");
  assertEquals(calls(lines, facts), ["test claude-plan"]);

  facts = {
    ...facts,
    plans: { "claude-plan": { signin: "done", test: "done", answer: "Ready." } },
  };
  lines = linesOf([claude], facts, []);
  assertEquals(shown(lines), ["computer done", "claude-plan done"]);
  assertEquals([finished(lines), connected(lines)], [true, [claude]]);
});

test("a plan signed in already only answers its test; one with no model to try is done at once", () => {
  const facts: Facts = {
    computer: "cloud-1",
    prepared: prepared({ claude: { ...installed, signedIn: true }, antigravity: installed }),
    plans: { "gemini-plan": { signin: "done" } },
  };
  const lines = linesOf([claude, gemini], facts, []);
  assertEquals(shown(lines), ["computer done", "claude-plan active testing", "gemini-plan done"]);
  assertEquals(calls(lines, facts), ["test claude-plan"]);
});

test("every failure ends in Try again, or what else fixes it: a laptop that's off, an installer that failed or can't run", () => {
  const computer = (failure: Facts["unprepared"], kept = false) =>
    shown(linesOf([claude], { computer: "c", kept, unprepared: failure, plans: {} }, []));
  // A laptop that's off: a cloud computer instead (or Try again, once it's on).
  assertEquals(computer({ code: "offline", message: "MacBook is off." }), [
    "computer failed cloud",
    "claude-plan waiting",
  ]);
  // A cloud computer that didn't wake, one that's shared, one that can't be reached: Try again.
  assertEquals(
    computer({ code: "offline", message: "It didn't wake." }, true)[0],
    "computer failed",
  );
  assertEquals(computer({ code: "computer_shared", message: "Shared." })[0], "computer failed");
  assertEquals(computer({ message: "Timed out" })[0], "computer failed");

  const ready = { computer: "c", prepared: prepared({ claude: missing }) };
  const line = (more: Partial<Facts>) =>
    shown(linesOf([claude], { ...ready, plans: {}, ...more }, []))[1];
  // On Windows the installer can't run here; an installer that failed: its command, a fallback.
  assertEquals(line({ os: "win32" }), "claude-plan failed installing terminal");
  assertEquals(
    line({ plans: { "claude-plan": { signin: "failed", installed: false } } }),
    "claude-plan failed installing terminal",
  );
  // Installed, the sign-in didn't finish (or its computer went offline): Try again.
  assertEquals(
    line({ plans: { "claude-plan": { signin: "failed", installed: true } } }),
    "claude-plan failed signin",
  );
  // Its test: at its limit, it's connected; any other failure, Try again.
  const tested = (code?: string) =>
    line({
      plans: {
        "claude-plan": {
          signin: "done",
          test: "failed",
          failure: { ...(code ? { code } : {}), message: "x" },
        },
      },
    });
  assertEquals(tested("engine_limit"), "claude-plan done limit");
  assertEquals(tested("engine_model"), "claude-plan failed testing");
  assertEquals(tested(), "claude-plan failed testing");
});

test("several plans in one pass, one at a time: ChatGPT on the server goes while the computer wakes; one failing stops only itself", () => {
  const ways = [claude, chatgpt, gemini];
  let facts: Facts = { computer: "cloud-1", kept: true, plans: {} };
  let lines = linesOf(ways, facts, []);
  assertEquals(shown(lines), [
    "computer active",
    "claude-plan waiting",
    "chatgpt active signin",
    "gemini-plan waiting",
  ]);
  assertEquals(calls(lines, facts), ["prepare cloud-1"]);

  // Ready while she's on ChatGPT's: Claude waits its turn, and nothing else starts.
  facts = { ...facts, prepared: prepared({ claude: installed, antigravity: installed }) };
  lines = linesOf(ways, facts, []);
  assertEquals(shown(lines).slice(1), [
    "claude-plan active signin",
    "chatgpt waiting",
    "gemini-plan waiting",
  ]);
  assertEquals(calls(lines, facts), ["signin claude-plan"]);

  // Claude's sign-in fails: ChatGPT (connected now) answers its test, then Google's goes.
  facts = { ...facts, plans: { "claude-plan": { signin: "failed", installed: true } } };
  lines = linesOf(ways, facts, [account("connected")]);
  assertEquals(shown(lines).slice(1), [
    "claude-plan failed signin",
    "chatgpt active testing",
    "gemini-plan waiting",
  ]);
  facts = { ...facts, plans: { ...facts.plans, chatgpt: { test: "done", answer: "Ready." } } };
  lines = linesOf(ways, facts, [account("connected")]);
  assertEquals(shown(lines).at(-1), "gemini-plan active signin");
  assertEquals(calls(lines, facts), ["signin gemini-plan"]);
  facts = { ...facts, plans: { ...facts.plans, "gemini-plan": { signin: "done" } } };
  lines = linesOf(ways, facts, [account("connected")]);
  assertEquals(finished(lines), true);
  assertEquals(connected(lines).map((w) => w.provider), ["chatgpt", "gemini-plan"]);
});

test("Try again checks the computer again and runs the line again, its plan from the start; nothing else", () => {
  const facts: Facts = {
    computer: "c",
    prepared: prepared({ claude: installed }),
    plans: {
      "claude-plan": { signin: "done", test: "failed", failure: { message: "x" } },
      "gemini-plan": { signin: "done" },
    },
  };
  const lines = linesOf([claude, gemini], facts, []);
  const again = retry(facts, lines.find((l) => l.key === "claude-plan")!);
  assertEquals(again.prepared, undefined);
  assertEquals(again.plans, { "gemini-plan": { signin: "done" } });
  assertEquals(calls(linesOf([claude, gemini], again, []), again), ["prepare c"]);
  // The computer's own: checked again; every plan as it was.
  const computer = retry({ ...facts, unprepared: { message: "x" } }, lines[0]);
  assertEquals([computer.unprepared, computer.plans], [undefined, facts.plans]);
});
