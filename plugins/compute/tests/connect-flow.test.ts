/**
 * The connect flow as a state machine (views/web/connect-lines.ts): from what
 * its calls answered, the checklist (each line waiting, active, done, or
 * failed with the one thing that fixes it) and the calls to make next. The
 * founder's test, step by step; every failure, and what's offered for it;
 * several plans in one pass, one sign-in at a time; and a fix forgetting
 * what it must, so its line runs again.
 */
import { assertEquals } from "@std/assert";
import type { Account } from "../../access/accounts/contract.ts";
import type { Prepared } from "../computers/actions/prepare.ts";
import {
  connected,
  type Facts,
  finished,
  forget,
  type Line,
  linesOf,
  nextOf,
} from "../computers/views/web/connect-lines.ts";
import type { Way } from "../computers/views/web/plan-states.ts";
import { test } from "../../../testing/mod.ts";

const claude: Way = {
  provider: "claude-plan",
  title: "Claude plan",
  plan: "Claude plan",
  engine: "claude",
  model: "claude-plan/claude-haiku-5-5",
};
const gemini: Way = {
  provider: "gemini-plan",
  title: "Google AI plan",
  plan: "Google AI plan",
  engine: "antigravity",
};
const chatgpt: Way = {
  provider: "chatgpt",
  title: "ChatGPT",
  plan: "ChatGPT plan",
  account: "chatgpt",
  model: "chatgpt/gpt-6-luna",
};

const prepared = (
  engines: Prepared["engines"] = {},
  current = true,
): Prepared => ({
  computer: "cloud-1",
  online: true,
  shared: false,
  engines,
  program: { version: current ? "1.0.0-rc.66" : "1.0.0-rc.60", current },
});
const at = "2026-11-25T10:00:00.000Z";
const missing = { installed: false, signedIn: false, at };
const installed = { installed: true, signedIn: false, at };

/** Each line as `key state` (and its note, or why it failed and its fix). */
const shown = (lines: Line[]) =>
  lines.map(({ key, state }) =>
    `${key} ${state.is}` +
    (state.is === "done" && state.note ? ` (${state.note})` : "") +
    (state.is === "failed" ? ` (${state.why}${state.fix ? `, ${state.fix}` : ""})` : "")
  );
const calls = (lines: Line[], facts: Facts) =>
  nextOf(lines, facts).map((n) =>
    n.call === "signin"
      ? `signin ${n.way.provider}${n.install ? " +install" : ""}`
      : n.call === "test"
      ? `test ${n.way.provider}`
      : `prepare ${n.computer}`
  );
const empty = (): Facts => ({ signins: {}, tests: {} });

test("the founder's test, as the flow runs it: the computer readied, Claude Code installed in its sign-in, signed in, answering", () => {
  let facts: Facts = { ...empty(), computer: "cloud-1", kept: true, os: "linux" };
  let lines = linesOf([claude], facts, []);
  assertEquals(shown(lines), [
    "computer active",
    "signin:claude-plan waiting",
    "test:claude-plan waiting",
  ]);
  assertEquals(calls(lines, facts), ["prepare cloud-1"]);

  // computer.prepare woke it, restarted it on the release, and asked it: Claude Code is missing.
  facts = { ...facts, preparing: true };
  assertEquals(calls(linesOf([claude], facts, []), facts), []);
  facts = { ...facts, preparing: false, prepared: prepared({ claude: missing }) };
  lines = linesOf([claude], facts, []);
  assertEquals(shown(lines), [
    "computer done",
    "install:claude-plan waiting",
    "signin:claude-plan active",
    "test:claude-plan waiting",
  ]);
  // Its sign-in installs it first: nobody is asked to.
  assertEquals(calls(lines, facts), ["signin claude-plan +install"]);

  facts = { ...facts, signins: { "claude-plan": { is: "running", installing: true } } };
  assertEquals(shown(linesOf([claude], facts, [])).slice(1, 3), [
    "install:claude-plan active",
    "signin:claude-plan active",
  ]);
  facts = {
    ...facts,
    signins: { "claude-plan": { is: "running", installing: true, url: "https://claude.ai/x" } },
  };
  assertEquals(shown(linesOf([claude], facts, [])).slice(1, 3), [
    "install:claude-plan done",
    "signin:claude-plan active",
  ]);

  facts = { ...facts, signins: { "claude-plan": { is: "done" } } };
  lines = linesOf([claude], facts, []);
  assertEquals(shown(lines).slice(2), ["signin:claude-plan done", "test:claude-plan active"]);
  assertEquals(calls(lines, facts), ["test claude-plan"]);

  facts = { ...facts, tests: { "claude-plan": { is: "done", text: "Ready." } } };
  lines = linesOf([claude], facts, []);
  assertEquals(shown(lines), [
    "computer done",
    "install:claude-plan done",
    "signin:claude-plan done",
    "test:claude-plan done",
  ]);
  assertEquals([finished(lines), connected(lines)], [true, [claude]]);
});

test("signed in already, the sign-in is done at once, and only the test runs; an old program goes on, saying so", () => {
  const facts: Facts = {
    ...empty(),
    computer: "cloud-1",
    prepared: prepared(
      { claude: { installed: true, signedIn: true, account: "a@b.c", at } },
      false,
    ),
  };
  const lines = linesOf([claude], facts, []);
  assertEquals(shown(lines), [
    "computer done (old)",
    "signin:claude-plan done (already)",
    "test:claude-plan active",
  ]);
  // Failing later, it says its program is older.
  const failing = {
    ...facts,
    tests: { "claude-plan": { is: "failed" as const, failure: { message: "No." } } },
  };
  const [, , tested] = linesOf([claude], failing, []);
  assertEquals(tested.state, {
    is: "failed",
    why: "test",
    fix: "retry",
    failure: { message: "No." },
    old: true,
  });
});

test("every failure ends in its fix: off, waking, shared, unreachable; installs, Windows; sign-ins; tests", () => {
  const computer = (failure: Facts["unprepared"], kept = false) =>
    shown(linesOf([claude], { ...empty(), computer: "c", kept, unprepared: failure }, []))[0];
  assertEquals(
    computer({ code: "offline", message: "MacBook is off." }),
    "computer failed (off, cloud)",
  );
  assertEquals(
    computer({ code: "offline", message: "It didn't wake." }, true),
    "computer failed (wake, retry)",
  );
  assertEquals(
    computer({ code: "computer_shared", message: "Shared." }),
    "computer failed (shared, shared)",
  );
  assertEquals(computer({ message: "Timed out" }), "computer failed (reach, retry)");

  const ready = { ...empty(), computer: "c", prepared: prepared({ claude: missing }) };
  // On Windows the installer can't run: its command, from the computer's terminal.
  assertEquals(shown(linesOf([claude], { ...ready, os: "win32" }, [])).slice(1, 3), [
    "install:claude-plan failed (windows, terminal)",
    "signin:claude-plan waiting",
  ]);
  // An installer that failed: the same fallback, with what it said.
  const notInstalled: Facts = {
    ...ready,
    signins: { "claude-plan": { is: "failed", installed: false } },
  };
  assertEquals(shown(linesOf([claude], notInstalled, [])).slice(1, 3), [
    "install:claude-plan failed (install, terminal)",
    "signin:claude-plan waiting",
  ]);
  // Installed, but the sign-in didn't finish; or its computer went offline.
  const signIn = (failure?: { code?: string; message: string }) =>
    shown(linesOf([claude], {
      ...ready,
      signins: {
        "claude-plan": { is: "failed", installed: true, ...(failure ? { failure } : {}) },
      },
    }, [])).slice(1, 3);
  assertEquals(signIn(), ["install:claude-plan done", "signin:claude-plan failed (signin, retry)"]);
  assertEquals(
    signIn({ code: "offline", message: "Gone." })[1],
    "signin:claude-plan failed (gone, retry)",
  );

  const tested = (code?: string) =>
    shown(linesOf([claude], {
      ...ready,
      prepared: prepared({ claude: installed }),
      signins: { "claude-plan": { is: "done" } },
      tests: {
        "claude-plan": { is: "failed", failure: { ...(code ? { code } : {}), message: "x" } },
      },
    }, [])).at(-1);
  assertEquals(tested("engine_limit"), "test:claude-plan done (limit)");
  assertEquals(tested("engine_model"), "test:claude-plan done (model)");
  assertEquals(tested("engine_signed_out"), "test:claude-plan failed (signedOut, signin)");
  assertEquals(tested(), "test:claude-plan failed (test, retry)");
});

test("several plans in one pass: ChatGPT signs in on the server while the computer wakes; then one sign-in at a time; one failing stops only itself", () => {
  const ways = [claude, chatgpt, gemini];
  const account = (status: Account["status"]): Account => ({
    _id: "a1",
    person: "ana",
    provider: "chatgpt",
    status,
    label: "ana@example.com",
    connected: at,
  });
  let facts: Facts = { ...empty(), computer: "cloud-1", kept: true };
  let lines = linesOf(ways, facts, []);
  assertEquals(shown(lines), [
    "computer active",
    "signin:claude-plan waiting",
    "test:claude-plan waiting",
    "signin:chatgpt active",
    "test:chatgpt waiting",
    "signin:gemini-plan waiting",
  ]);
  assertEquals(calls(lines, facts), ["prepare cloud-1"]);

  // Ready, while the person is still on ChatGPT's: it stays theirs; Claude's waits.
  facts = {
    ...facts,
    attending: "chatgpt",
    prepared: prepared({ claude: installed, antigravity: installed }),
  };
  lines = linesOf(ways, facts, []);
  assertEquals(shown(lines).slice(1, 4), [
    "signin:claude-plan waiting",
    "test:claude-plan waiting",
    "signin:chatgpt active",
  ]);
  assertEquals(calls(lines, facts), []);

  // ChatGPT connected (its account says so): its test, and Claude's sign-in, go.
  lines = linesOf(ways, facts, [account("connected")]);
  assertEquals(shown(lines).slice(1), [
    "signin:claude-plan active",
    "test:claude-plan waiting",
    "signin:chatgpt done",
    "test:chatgpt active",
    "signin:gemini-plan waiting",
  ]);
  assertEquals(calls(lines, facts), ["signin claude-plan", "test chatgpt"]);

  // Claude's sign-in fails: Google's goes on.
  facts = { ...facts, attending: undefined, signins: { "claude-plan": { is: "failed" } } };
  lines = linesOf(ways, facts, [account("connected")]);
  assertEquals(
    shown(lines).find((l) => l.startsWith("signin:gemini")),
    "signin:gemini-plan active",
  );
  assertEquals(calls(lines, facts).includes("signin gemini-plan"), true);
  facts = {
    ...facts,
    signins: { ...facts.signins, "gemini-plan": { is: "done" } },
    tests: { chatgpt: { is: "done", text: "Ready." } },
  };
  lines = linesOf(ways, facts, [account("connected")]);
  assertEquals(finished(lines), true);
  assertEquals(connected(lines).map((w) => w.provider), ["chatgpt", "gemini-plan"]);
});

test("a fix forgets what its line needs again, and nothing else", () => {
  const facts: Facts = {
    ...empty(),
    computer: "c",
    prepared: prepared({ claude: installed }),
    signins: { "claude-plan": { is: "done" }, "gemini-plan": { is: "failed" } },
    tests: {
      "claude-plan": { is: "failed", failure: { code: "engine_signed_out", message: "x" } },
    },
  };
  const lines = linesOf([claude, gemini], facts, []);
  const line = (key: string) => lines.find((l) => l.key === key)!;
  // Signed out after all: the computer is asked again, and Claude signs in again.
  const again = forget(facts, line("test:claude-plan"));
  assertEquals([again.prepared, again.signins["claude-plan"], again.tests["claude-plan"]], [
    undefined,
    undefined,
    undefined,
  ]);
  assertEquals(again.signins["gemini-plan"], { is: "failed" });
  // Google's sign-in again: only it.
  const retried = forget(facts, line("signin:gemini-plan"));
  assertEquals(retried.signins, { "claude-plan": { is: "done" } });
  assertEquals(retried.prepared, facts.prepared);
});
