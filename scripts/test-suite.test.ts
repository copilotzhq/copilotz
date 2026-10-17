import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseTestSuiteArgs,
  prepareTestSuite,
  runTestBatch,
  runTestSuite,
  TEST_ROOTS,
} from "./test-suite.mjs";

async function fixture(
  run: (root: string, temporary: string) => Promise<void>,
) {
  const temporary = await mkdtemp(join(tmpdir(), "copilotz-suite-"));
  const root = join(temporary, "source # space");
  try {
    await mkdir(root);
    await writeFile(
      join(root, "deno.json"),
      JSON.stringify({ name: "@copilotz/copilotz" }),
    );
    for (const path of TEST_ROOTS) {
      await mkdir(join(root, path), { recursive: true });
    }
    for (
      const path of [
        "runtime/a.test.ts",
        "plugins/b_test.ts",
        "build/test.mts",
        "client/empty.test.tsx",
        "server/test.js",
        "scripts/c.test.cts",
        "contracts/package/d.test.jsx",
      ]
    ) {
      await writeFile(
        join(root, path),
        "// Deliberate zero-case setup fixture.\n",
      );
    }
    await writeFile(
      join(root, "runtime/not-a-test.ts"),
      "// Not a test suffix.\n",
    );
    await run(root, temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("suite CLI rejects unsafe/unknown options and separates plan from execution", () => {
  assert.deepEqual(parseTestSuiteArgs(["--help"]), { help: true });
  const defaultPlan = parseTestSuiteArgs(["--plan"]);
  const referencePlan = parseTestSuiteArgs(["--plan", "--batch-size", "1"]);
  assert.ok("batchSize" in defaultPlan);
  assert.ok("batchSize" in referencePlan);
  assert.equal(defaultPlan.batchSize, 32);
  assert.equal(referencePlan.batchSize, 1);
  for (
    const args of [
      [],
      ["--plan", "--no-check"],
      ["--plan", "--plan"],
      ["--output"],
      ["--plan", "--batch-size", "0"],
      ["--plan", "--batch-size", "129"],
      ["--plan", "--batch-size", "2.5"],
      ["--plan", "--batch-size", "2x"],
    ]
  ) {
    assert.throws(() => parseTestSuiteArgs(args));
  }
});

test("full inventory preserves seven roots, all suffixes, zero-case modules and exact hashes", async () => {
  await fixture(async (root) => {
    const one = await prepareTestSuite({ root, batchSize: 1 });
    const grouped = await prepareTestSuite({ root, batchSize: 3 });
    assert.equal(one.inventory.length, 7);
    assert.equal(one.mode, "full-retained-suite-candidate");
    assert.equal(one.releaseGate, false);
    assert.deepEqual(one.inventory, grouped.inventory);
    assert.deepEqual(one.selected, grouped.batches.flat());
    assert.deepEqual(one.selected, [...one.selected].sort());
    assert.deepEqual(grouped.batches.map((batch: string[]) => batch.length), [
      3,
      3,
      1,
    ]);
    assert.ok(
      one.inventory.every((file: { sha256: string }) =>
        /^[a-f0-9]{64}$/.test(file.sha256)
      ),
    );
    assert.deepEqual(one.flags, ["test", "--allow-all"]);
    assert.deepEqual(one.exclusions, []);
    assert.equal(one.concurrency, 1);
  });
});

test("scoped feedback validates exact discovered paths and never claims full coverage", async () => {
  await fixture(async (root) => {
    const plan = await prepareTestSuite({ root, files: ["runtime/a.test.ts"] });
    assert.equal(plan.mode, "scoped-feedback");
    assert.equal(plan.inventory.length, 7);
    assert.deepEqual(plan.selected, ["runtime/a.test.ts"]);
    for (
      const files of [["../outside.test.ts"], ["runtime/not-a-test.ts"], [
        "runtime/a.test.ts",
        "runtime/a.test.ts",
      ]]
    ) {
      await assert.rejects(prepareTestSuite({ root, files }));
    }
  });
});

test("missing roots and symlinks fail closed rather than silently dropping coverage", async () => {
  await fixture(async (root, temporary) => {
    await symlink(
      join(temporary, "outside.test.ts"),
      join(root, "runtime/link.test.ts"),
    );
    await assert.rejects(prepareTestSuite({ root }), /symbolic link/);
    await rm(join(root, "runtime/link.test.ts"));
    await rm(join(root, "build"), { recursive: true });
    await assert.rejects(prepareTestSuite({ root }), /ENOENT/);
  });
});

test("source configuration is hashed and forwarded unchanged", async () => {
  await fixture(async (root, temporary) => {
    const config = join(temporary, "source config.json");
    const bytes = '{"imports":{}}\n';
    await writeFile(config, bytes);
    const plan = await prepareTestSuite({
      root,
      config,
      deno: "/runtime with spaces/deno",
    });
    assert.deepEqual(plan.flags, ["test", "--config", config, "--allow-all"]);
    assert.equal(plan.executable, "/runtime with spaces/deno");
    assert.equal(await readFile(config, "utf8"), bytes);
  });
});

test("scheduler serializes exact batches, preserves environment and records failed members without retry", async () => {
  await fixture(async (root, temporary) => {
    const plan = await prepareTestSuite({ root, batchSize: 2 });
    const calls: string[][] = [];
    const env = {
      COPILOTZ_TEST_POSTGRES_URL: "private-test-url",
      COPILOTZ_OXIAN_SOURCE_ROOT: "fixture",
    };
    const output = join(temporary, "results");
    let running = false;
    const result = await runTestSuite(
      plan,
      { output, env },
      async (
        _command: string,
        args: string[],
        options: { env: unknown; cwd: string },
      ) => {
        assert.equal(running, false);
        running = true;
        assert.equal(options.env, env);
        assert.equal(options.cwd, root);
        calls.push(args);
        await Promise.resolve();
        running = false;
        return { exitCode: calls.length === 2 ? 1 : 0, signal: null };
      },
    );
    assert.deepEqual(
      calls,
      plan.batches.map((batch: string[]) => [...plan.flags, ...batch]),
    );
    assert.equal(result.status, "incomplete-or-failed");
    assert.deepEqual(
      result.filesWithoutIndividualCompletionEvidence,
      plan.batches[1],
    );
    assert.deepEqual(result.unrunFiles, []);
    assert.equal(result.batches.length, 4);
    assert.equal(
      (await readFile(join(output, "summary.json"), "utf8")).includes(
        "private-test-url",
      ),
      false,
    );
    await assert.rejects(
      runTestSuite(plan, { output }, async () => {
        throw new Error("must not launch");
      }),
      /EEXIST/,
    );
  });
});

test("launch failures remain explicit and later batches still run", async () => {
  await fixture(async (root, temporary) => {
    const plan = await prepareTestSuite({ root, batchSize: 4 });
    let calls = 0;
    const result = await runTestSuite(plan, {
      output: join(temporary, "results"),
    }, async () => {
      if (++calls === 1) throw new Error("missing executable");
      return { exitCode: 0, signal: null };
    });
    assert.equal(calls, 2);
    assert.equal(result.batches[0].status, "launch-error");
    assert.equal(result.status, "incomplete-or-failed");
  });
});

test("cancellation retains interrupted members and names all unlaunched files", async () => {
  await fixture(async (root, temporary) => {
    const plan = await prepareTestSuite({ root, batchSize: 2 });
    const controller = new AbortController();
    const result = await runTestSuite(plan, {
      output: join(temporary, "results"),
      signal: controller.signal,
    }, async () => {
      controller.abort("SIGINT");
      return { exitCode: null, signal: "SIGINT" };
    });
    assert.equal(result.batches.length, 1);
    assert.equal(result.batches[0].status, "interrupted");
    assert.deepEqual(
      result.filesWithoutIndividualCompletionEvidence,
      plan.batches[0],
    );
    assert.deepEqual(result.unrunFiles, plan.selected.slice(2));
  });
});

test("successful scheduling is a candidate-suite result, never release readiness", async () => {
  await fixture(async (root, temporary) => {
    const plan = await prepareTestSuite({ root });
    const result = await runTestSuite(plan, {
      output: join(temporary, "results"),
    }, async () => ({ exitCode: 0, signal: null }));
    assert.equal(result.status, "passed");
    assert.equal(result.releaseGate, false);
    assert.deepEqual(result.unrunFiles, []);
    assert.deepEqual(result.filesWithoutIndividualCompletionEvidence, []);
  });
});

test("real child captures raw logs and nonzero exit without a shell", async () => {
  await fixture(async (root, temporary) => {
    const stdout = join(temporary, "stdout.log");
    const stderr = join(temporary, "stderr.log");
    const result = await runTestBatch("node", [
      "-e",
      "if (!process.versions.node || process.versions.deno) throw new Error('Expected Node fixture runtime'); console.log('out'); console.error('err'); process.exitCode = 17",
    ], { cwd: root, env: process.env, stdout, stderr });
    assert.equal(result.exitCode, 17);
    assert.equal(await readFile(stdout, "utf8"), "out\n");
    assert.equal(await readFile(stderr, "utf8"), "err\n");
    const success = await runTestBatch("node", [
      "-e",
      "console.log('success')",
    ], {
      cwd: root,
      env: process.env,
      stdout: join(temporary, "success.out"),
      stderr: join(temporary, "success.err"),
    });
    assert.equal(success.exitCode, 0);
    assert.equal(
      await readFile(join(temporary, "success.out"), "utf8"),
      "success\n",
    );
  });
});

test("real missing executable reports launch error", async () => {
  await fixture(async (root, temporary) => {
    const result = await runTestBatch(join(temporary, "missing"), [], {
      cwd: root,
      env: process.env,
      stdout: join(temporary, "out"),
      stderr: join(temporary, "err"),
    });
    assert.match(result.error ?? "", /ENOENT/);
    assert.notEqual(result.exitCode, 0);
  });
});

test("already-aborted default reason does not launch a child", async () => {
  await fixture(async (root, temporary) => {
    const controller = new AbortController();
    controller.abort();
    const result = await runTestBatch("node", [
      "-e",
      "throw new Error('must not launch')",
    ], {
      cwd: root,
      env: process.env,
      stdout: join(temporary, "out"),
      stderr: join(temporary, "err"),
      signal: controller.signal,
    });
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.launched, false);
  });
});

test("mid-run default abort terminates the real child and POSIX descendant", async () => {
  await fixture(async (root, temporary) => {
    const stdout = join(temporary, "out");
    const controller = new AbortController();
    const code =
      "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000)";
    const running = runTestBatch("node", ["-e", code], {
      cwd: root,
      env: process.env,
      stdout,
      stderr: join(temporary, "err"),
      signal: controller.signal,
    });
    let pid = 0;
    let result;
    try {
      const deadline = Date.now() + 5000;
      while (!pid && Date.now() < deadline) {
        try {
          pid = Number((await readFile(stdout, "utf8")).trim());
        } catch { /* Wait for child readiness. */ }
        if (!pid) await new Promise((done) => setTimeout(done, 10));
      }
      assert.ok(pid, "child reports descendant readiness");
    } finally {
      controller.abort();
      result = await running;
    }
    assert.equal(result.signal, "SIGTERM");
    if (process.platform !== "win32") {
      // A killed orphan can remain a zombie until the container init reaps it.
      let live = true;
      const deadline = Date.now() + 5000;
      while (live && Date.now() < deadline) {
        try {
          process.kill(pid, 0);
          if (process.platform === "linux") {
            live = !(await readFile(`/proc/${pid}/stat`, "utf8")).includes(
              ") Z ",
            );
          }
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === "ESRCH" ||
            (error as NodeJS.ErrnoException).code === "ENOENT"
          ) live = false;
          else throw error;
        }
        if (live) await new Promise((done) => setTimeout(done, 10));
      }
      assert.equal(live, false, "POSIX descendant is no longer executing");
    } else {
      // Windows only promises direct-child termination; clean up this fixture.
      try {
        process.kill(pid);
      } catch { /* Already gone. */ }
    }
  });
});
