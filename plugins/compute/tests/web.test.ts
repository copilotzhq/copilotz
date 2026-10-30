/**
 * Computers on the web, their logic: what an agent waits on you for, in
 * words; the person's shell as the web terminal drives it (a command, its
 * output as it comes, input, Ctrl+C, where it is); what changed in an
 * edit; what a computer tool's call came to; how things are named; and the
 * visitor's own computer, for the connect flow.
 */
import { assertEquals } from "@std/assert";
import type { TerminalOutput } from "../../../hosts/web/mod.ts";
import type { TerminalInput, TerminalResult } from "../computers/shared/workloads.ts";
import { asked, previewOf, reach, sentence } from "../computers/views/web/asked.ts";
import { ending, shellSession, where } from "../computers/views/web/shell.ts";
import { lineDiff } from "../computers/views/web/diff.ts";
import { listOf, outcome, terminalCall, took } from "../computers/views/web/calls.ts";
import { folderPath, nameOf, systemOf, tilde, whose } from "../computers/views/web/names.ts";
import { archName, visitorArch, visitorSystem } from "../computers/views/web/platform.ts";
import { test } from "../../../testing/mod.ts";

test("what an agent waits on you for, in words", () => {
  const run = { agent: "assistant", work: "terminal", detail: "npm test" };
  const write = { agent: "assistant", work: "writes", detail: "write src/a.ts" };
  const edit = { agent: "coder", work: "writes", detail: "edit README.md" };
  const job = { agent: "assistant", work: "jobs", detail: "npm run dev" };
  assertEquals(
    [run, write, edit, job].map(asked),
    [
      { verb: "run", wants: "wants to run", what: "npm test" },
      { verb: "write", wants: "wants to write", what: "src/a.ts" },
      { verb: "edit", wants: "wants to edit", what: "README.md" },
      { verb: "start", wants: "wants to start", what: "npm run dev" },
    ],
  );
  assertEquals(sentence(write), "assistant wants to write src/a.ts");
  assertEquals(reach("once", run, "laptop"), "assistant may run npm test, this once.");
  assertEquals(
    reach("thread", edit, "laptop"),
    "coder may change files on laptop without asking again, in this conversation.",
  );
  assertEquals(
    reach("always", job),
    "assistant may start jobs on this computer without asking again, in any conversation.",
  );
});

test("what a write would write, as its ask shows it: a new file, an edit's change, cut short", () => {
  assertEquals(previewOf("# Plan\n- [ ] Ship"), [{ text: "# Plan\n- [ ] Ship\n", tone: "added" }]);
  assertEquals(previewOf("- old line\n+ new line\n+ another", "edit"), [
    { text: "old line\n", tone: "removed" },
    { text: "new line\n", tone: "added" },
    { text: "another\n", tone: "added" },
  ]);
  // An empty line, removed, is still a line of the change.
  assertEquals(previewOf("-\n+ x", "edit"), [
    { text: "\n", tone: "removed" },
    { text: "x\n", tone: "added" },
  ]);
  assertEquals(previewOf("a\nb\n…"), [
    { text: "a\nb\n", tone: "added" },
    { text: "…\n", tone: "muted" },
  ]);
  assertEquals(previewOf("- a\n+ b\n…", "edit"), [
    { text: "a\n", tone: "removed" },
    { text: "b\n", tone: "added" },
    { text: "…\n", tone: "muted" },
  ]);
  // Not a change line by line: as it is.
  assertEquals(previewOf("replaced the intro", "edit"), [{ text: "replaced the intro\n" }]);
});

/** A shell that answers from a script, and what was asked of it; output, as the terminal took it. */
function scripted(answers: ((input: Omit<TerminalInput, "scope">) => Partial<TerminalResult>)[]) {
  const asked: Omit<TerminalInput, "scope">[] = [];
  const ask = (input: Omit<TerminalInput, "scope">) => {
    asked.push(input);
    const next = answers.shift() ?? (() => ({}));
    return Promise.resolve({
      state: "idle",
      commandId: "c1",
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 0,
      timedOut: false,
      durationMs: 5,
      cwd: ".",
      ...next(input),
    } as TerminalResult);
  };
  const shown: string[] = [];
  const out: TerminalOutput = {
    write: (text) => void shown.push(text),
    error: (text) => void shown.push(`!${text}`),
    note: (text) => void shown.push(`#${text}`),
    signal: new AbortController().signal,
  };
  return { ask, asked, shown, out };
}

test("the web's shell: a command, its output as it comes, and where it is after", async () => {
  const { ask, asked, shown, out } = scripted([
    () => ({ state: "running", stdout: "tick 1\n", exitCode: null }),
    () => ({ state: "running", stdout: "tick 2\n", exitCode: null }),
    () => ({ stdout: "tick 3\n", stderr: "warned\n", exitCode: 2, cwd: "src" }),
  ]);
  const shell = shellSession(ask, { folder: "personal", wait: () => Promise.resolve() });
  assertEquals(shell.prompt(), "personal");
  await shell.run("cd src && ./ticks", out);
  assertEquals(asked, [
    { stdin: "cd src && ./ticks" },
    { stdin: "", commandId: "c1" },
    { stdin: "", commandId: "c1" },
  ]);
  assertEquals(shown, ["tick 1\n", "tick 2\n", "tick 3\n", "!warned\n", "#exit 2"]);
  assertEquals([shell.prompt(), shell.running()], ["personal/src", undefined]);
});

test("the web's shell: input and Ctrl+C go to the command running, even before it answers", async () => {
  let answer!: () => void;
  const late = new Promise<void>((resolve) => answer = resolve);
  const asked: Omit<TerminalInput, "scope">[] = [];
  // A command that reads a line, says hi, then sleeps until it's interrupted.
  let said = "";
  let stopped = false;
  const ask = async (input: Omit<TerminalInput, "scope">) => {
    asked.push(input);
    if (asked.length === 1) await late;
    else await new Promise((r) => setTimeout(r, 1));
    if (input.stdin?.endsWith("\n")) said = `hi ${input.stdin.trim()}\n`;
    if (input.operation === "interrupt") stopped = true;
    const stdout = said;
    said = "";
    return {
      state: stopped ? "idle" : "running",
      commandId: "c9",
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: stopped ? 130 : null,
      timedOut: false,
      ...(stopped ? { interrupted: true } : {}),
      durationMs: 5,
      cwd: ".",
    } as TerminalResult;
  };
  const shown: string[] = [];
  const out: TerminalOutput = {
    write: (text) => void shown.push(text),
    error: (text) => void shown.push(`!${text}`),
    note: (text) => void shown.push(`#${text}`),
    signal: new AbortController().signal,
  };
  const shell = shellSession(ask, { folder: "f", wait: () => Promise.resolve() });
  const running = shell.run("read who; echo hi $who; sleep 9", out);
  // Typed before the command's first answer: it waits for it.
  const typed = shell.input!("ana", out);
  answer();
  await typed;
  await shell.interrupt!(out);
  await running;
  assertEquals(asked[0], { stdin: "read who; echo hi $who; sleep 9" });
  assertEquals(asked.find((a) => a.stdin === "ana\n"), { stdin: "ana\n", commandId: "c9" });
  assertEquals(asked.find((a) => a.operation), { operation: "interrupt", commandId: "c9" });
  assertEquals(shown.includes("hi ana\n"), true);
  assertEquals(shown.at(-1), "#stopped");
});

test("the web's shell: opening it says where it is, and picks up a command still running", async () => {
  const idle = scripted([() => ({ cwd: "app", commandId: "fresh" })]);
  const shell = shellSession(idle.ask, { folder: "space" });
  await shell.start!(idle.out);
  assertEquals([idle.asked, idle.shown, shell.prompt()], [[{ stdin: "" }], [], "space/app"]);

  const busy = scripted([
    () => ({ state: "running", stdout: "serving\n", exitCode: null }),
    () => ({ stdout: "bye\n" }),
  ]);
  await shellSession(busy.ask, { folder: "space", wait: () => Promise.resolve() }).start!(busy.out);
  assertEquals(busy.shown, ["#Still running from before; Ctrl+C stops it.", "serving\n", "bye\n"]);
});

test("how a command ended, and where the shell is, as the terminal says them", () => {
  const base = {
    state: "idle" as const,
    commandId: "c",
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    cwd: ".",
  };
  assertEquals(ending(base), undefined);
  assertEquals(ending({ ...base, exitCode: 1 }), "exit 1");
  assertEquals(ending({ ...base, exitCode: 130, interrupted: true }), "stopped");
  assertEquals(
    ending({ ...base, exitCode: 124, timedOut: true, stdoutTruncated: true }),
    [
      "timed out",
      "exit 124",
      "some output was left out",
    ].join(" · "),
  );
  assertEquals([where("p", "."), where("p", "a/b"), where("p", "/tmp")], ["p", "p/a/b", "/tmp"]);
});

test("what changed in an edit, line by line, with a little of what's around it", () => {
  assertEquals(lineDiff("a\nb\nc\n", "a\nB\nc\n"), [
    { text: "a" },
    { text: "b", tone: "removed" },
    { text: "B", tone: "added" },
    { text: "c" },
  ]);
  assertEquals(lineDiff("", "new\n"), [{ text: "new", tone: "added" }]);
  assertEquals(lineDiff("x\ny", "x\ny"), [{ text: "x" }, { text: "y" }]);
  const long = ["1", "2", "3", "4", "5", "6"];
  assertEquals(
    lineDiff([...long, "old", ...long].join("\n"), [...long, "new", ...long].join("\n"), 2),
    [
      { skipped: 4 },
      { text: "5" },
      { text: "6" },
      { text: "old", tone: "removed" },
      { text: "new", tone: "added" },
      { text: "1" },
      { text: "2" },
      { skipped: 4 },
    ],
  );
  // A line moved: what they share stays, the rest is what went and came.
  assertEquals(lineDiff("a\nb\nc", "b\nc\na"), [
    { text: "a", tone: "removed" },
    { text: "b" },
    { text: "c" },
    { text: "a", tone: "added" },
  ]);
});

test("what a computer tool's call came to, from what it returned", () => {
  assertEquals(outcome({}), { kind: "running" });
  assertEquals(
    outcome({ output: "Waiting for ana's yes to run this on their computer: ls\nThey see…" })
      .kind,
    "waiting",
  );
  assertEquals(outcome({ output: "ana has no computer connected. They can…" }).kind, "missing");
  assertEquals(outcome({ output: "Error: The computer is gone" }), {
    kind: "failed",
    text: "The computer is gone",
  });
  assertEquals(outcome({ output: '{"error":{"message":"No such file","code":"not_found"}}' }), {
    kind: "failed",
    text: "No such file",
  });
  assertEquals(outcome({ output: '{"size":2}' }), { kind: "done", value: { size: 2 } });
  assertEquals(outcome({ output: "4" }), { kind: "done", value: 4 });
  assertEquals(listOf([1], "x"), [1]);
  assertEquals(listOf({ results: [2] }, "results"), [2]);
  assertEquals(listOf("nope", "results"), []);

  const result = {
    state: "idle",
    commandId: "c",
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
    durationMs: 3,
    cwd: ".",
  };
  assertEquals(
    terminalCall({ input: { stdin: "ls" }, output: JSON.stringify(result) }).mode,
    "run",
  );
  assertEquals(
    terminalCall({ input: { stdin: "ls" }, output: JSON.stringify(result) }).result?.stdout,
    "ok\n",
  );
  assertEquals(terminalCall({ input: { stdin: "", commandId: "c" } }).mode, "poll");
  assertEquals(terminalCall({ input: { stdin: "y\n", commandId: "c" } }), {
    mode: "input",
    text: "y",
  });
  assertEquals(
    terminalCall({ input: { operation: "interrupt", commandId: "c" } }).mode,
    "interrupt",
  );
  assertEquals([84, 2_400, 12_000, 72_000].map(took), ["84 ms", "2.4 s", "12 s", "1 m 12 s"]);
});

test("how computers and what's on them are named", () => {
  assertEquals(nameOf({ name: "laptop", info: { hostname: "mbp" } }), "laptop");
  assertEquals(nameOf({ info: { hostname: "mbp" } }), "mbp");
  assertEquals(nameOf({}), "Computer");
  assertEquals([systemOf("darwin"), systemOf("linux"), systemOf("plan9")], [
    "macOS",
    "Linux",
    "plan9",
  ]);
  assertEquals(
    [tilde("/Users/ana/Copilotz"), tilde("/home/bo"), tilde("/srv/x"), tilde("C:\\Users\\cy\\C")],
    ["~/Copilotz", "~", "/srv/x", "~\\C"],
  );
  assertEquals(folderPath({ info: { root: "/home/ana/Copilotz" } }, "acme"), "~/Copilotz/acme");
  // Before it's said where its root is, nowhere yet.
  assertEquals(folderPath({}, "acme"), undefined);
  assertEquals(whose("agent:assistant", "ana"), { name: "assistant", agent: true, mine: false });
  assertEquals(whose("person:ana", "ana"), { name: "you", agent: false, mine: true });
  assertEquals(whose("person:bob", "ana"), { name: "bob", agent: false, mine: false });
});

test("the visitor's system and architecture, as their browser says them", async () => {
  const nav = (userAgent: string, more: Record<string, unknown> = {}) =>
    ({ userAgent, platform: "", maxTouchPoints: 0, ...more }) as unknown as Navigator;
  const mac = nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
  assertEquals(visitorSystem(mac), "darwin");
  assertEquals(visitorSystem(nav("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")), "win32");
  assertEquals(visitorSystem(nav("Mozilla/5.0 (X11; Linux x86_64)")), "linux");
  // A phone or a tablet isn't the computer being connected (an iPad says it's a Mac).
  assertEquals(
    visitorSystem(nav("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")),
    undefined,
  );
  assertEquals(visitorSystem(nav("Mozilla/5.0 (Linux; Android 15; Pixel 9)")), undefined);
  assertEquals(
    visitorSystem(nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", { maxTouchPoints: 5 })),
    undefined,
  );
  // Chromium says the architecture; a user agent sometimes does.
  const arm = nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", {
    userAgentData: {
      platform: "macOS",
      mobile: false,
      getHighEntropyValues: () => Promise.resolve({ architecture: "arm", bitness: "64" }),
    },
  });
  assertEquals(await visitorArch(arm), "arm64");
  assertEquals(await visitorArch(nav("Mozilla/5.0 (X11; Linux aarch64)")), "arm64");
  assertEquals(await visitorArch(nav("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")), "x64");
  assertEquals(
    ["darwin-arm64", "darwin-x64", "linux-arm64", "win32-x64"].map((p) =>
      archName(...(p.split("-") as [string, string]))
    ),
    ["Apple silicon", "Intel", "Arm (64-bit)", "64-bit (x64; Windows on Arm runs it too)"],
  );
});
