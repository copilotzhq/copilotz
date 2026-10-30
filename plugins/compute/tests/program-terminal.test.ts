/**
 * The computer's terminal, as the plugin uses it: a shell per space's folder
 * and who, answering within about a second, polled until done, interrupted.
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { test } from "../../../testing/mod.ts";
import { type Scope, type TerminalResult, WORK } from "../computers/shared/workloads.ts";
import { setup } from "./program-setup.ts";

const scope = (who: string, folder = "alpha"): Scope => ({ space: `space-${folder}`, folder, who });

/** bash's contract: a Windows computer's shell is PowerShell, whose is program-powershell.test.ts. */
const posix = (name: string, fn: () => Promise<void>) =>
  test({ name, ignore: process.platform === "win32", fn });

posix("two agents in one space keep their own working directory and environment", async () => {
  await setup(async ({ work }) => {
    const run = (who: string, stdin: string) =>
      work<TerminalResult>(WORK.terminal, { scope: scope(who), stdin });
    const a = await run("agent:a", "mkdir -p sub && cd sub && export SECRET_X=1 && echo set");
    assertEquals([a.state, a.stdout, a.exitCode, a.cwd], ["idle", "set\n", 0, "sub"]);
    const b = await run("agent:b", 'echo "x=$SECRET_X"');
    assertEquals([b.stdout, b.cwd], ["x=\n", "."]);
    const again = await run("agent:a", 'echo "x=$SECRET_X"; pwd');
    assertEquals(again.cwd, "sub");
    assertMatch(again.stdout, /^x=1\n.*\/alpha\/sub\n$/);
    // What a command writes to stderr, and how it ends, come apart.
    const failed = await run("agent:b", "echo out; echo err >&2; exit 3");
    assertEquals([failed.stdout, failed.stderr, failed.exitCode], ["out\n", "err\n", 3]);
    // Its shell ended; the next command gets a new one, at the space's folder.
    assertEquals((await run("agent:b", "pwd")).cwd, ".");
  });
});

posix("two spaces have folders of their own", async () => {
  await setup(async ({ work, root }) => {
    const pwd = (folder: string) =>
      work<TerminalResult>(WORK.terminal, {
        scope: scope("agent:a", folder),
        stdin: "pwd; touch here",
      });
    const alpha = await pwd("alpha");
    const beta = await pwd("beta");
    assertEquals(alpha.stdout.trim(), realpathSync(join(root, "alpha")));
    assertEquals(beta.stdout.trim(), realpathSync(join(root, "beta")));
    const ls = await work<TerminalResult>(WORK.terminal, {
      scope: scope("agent:b", "beta"),
      stdin: "ls",
    });
    assertEquals(ls.stdout, "here\n");
  });
});

posix("a long command answers while running, then polls to completion", async () => {
  await setup(async ({ work }) => {
    const started = Date.now();
    const first = await work<TerminalResult>(WORK.terminal, {
      scope: scope("agent:a"),
      stdin: "echo starting; sleep 2; echo finished",
    });
    assertEquals([first.state, first.exitCode, first.stdout], ["running", null, "starting\n"]);
    assert(Date.now() - started < 1900, "it answered within about a second");
    let last = first;
    const out = [first.stdout];
    while (last.state === "running") {
      last = await work<TerminalResult>(WORK.terminal, {
        scope: scope("agent:a"),
        stdin: "",
        commandId: first.commandId,
      });
      assertEquals(last.commandId, first.commandId);
      out.push(last.stdout);
    }
    assertEquals([last.exitCode, out.join("")], [0, "starting\nfinished\n"]);
    // Another agent can't poll it.
    const theirs = await work<{ error: { code: string } }>(WORK.terminal, {
      scope: scope("agent:b"),
      stdin: "",
      commandId: first.commandId,
    });
    assertEquals(theirs.error.code, "not_found");
  });
});

posix("a running command reads stdin sent to it, and is interrupted", async () => {
  await setup(async ({ work }) => {
    const asking = await work<TerminalResult>(WORK.terminal, {
      scope: scope("agent:a"),
      stdin: 'read -r name; echo "hello $name"',
    });
    assertEquals(asking.state, "running");
    const answered = await work<TerminalResult>(WORK.terminal, {
      scope: scope("agent:a"),
      stdin: "Ada\n",
      commandId: asking.commandId,
    });
    assertEquals([answered.state, answered.stdout, answered.exitCode], ["idle", "hello Ada\n", 0]);

    const sleeping = await work<TerminalResult>(WORK.terminal, {
      scope: scope("agent:a"),
      stdin: "export KEPT=yes; sleep 30",
    });
    assertEquals(sleeping.state, "running");
    const stopped = await work<TerminalResult>(WORK.terminal, {
      scope: scope("agent:a"),
      operation: "interrupt",
      commandId: sleeping.commandId,
    });
    assertEquals([stopped.state, stopped.interrupted, stopped.exitCode], ["idle", true, 130]);
    // The shell outlived it, with what the command set.
    const after = await work<TerminalResult>(WORK.terminal, {
      scope: scope("agent:a"),
      stdin: 'echo "kept=$KEPT"',
    });
    assertEquals(after.stdout, "kept=yes\n");
  });
});

posix("a command times out, and a shell unused for a while goes", async () => {
  await setup(async ({ work }) => {
    const slow = await work<TerminalResult>(WORK.terminal, {
      scope: scope("agent:a"),
      stdin: "sleep 5",
    });
    let last = slow;
    while (last.state === "running") {
      last = await work<TerminalResult>(WORK.terminal, {
        scope: scope("agent:a"),
        stdin: "",
        commandId: slow.commandId,
      });
    }
    assertEquals([last.timedOut, last.exitCode], [true, 143]);

    await work(WORK.terminal, { scope: scope("agent:b"), stdin: "export GONE=no" });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const fresh = await work<TerminalResult>(WORK.terminal, {
      scope: scope("agent:b"),
      stdin: 'echo "gone=$GONE"',
    });
    assertEquals(fresh.stdout, "gone=\n");
  }, { shells: { runtimeMs: 400, shellIdleMs: 300 } });
});

posix("children see the person's environment, not the program's own settings", async () => {
  const env = process.env;
  env.COPILOTZ_TEST_HIDDEN = "hidden";
  env.PERSON_TEST_SHOWN = "shown";
  try {
    await setup(async ({ work }) => {
      const seen = await work<TerminalResult>(WORK.terminal, {
        scope: scope("agent:a"),
        stdin: 'echo "${COPILOTZ_TEST_HIDDEN:-none} $PERSON_TEST_SHOWN"',
      });
      assertEquals(seen.stdout, "none shown\n");
    });
  } finally {
    delete env.COPILOTZ_TEST_HIDDEN;
    delete env.PERSON_TEST_SHOWN;
  }
});
