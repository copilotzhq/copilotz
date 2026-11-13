/**
 * Memory budgets. The docs app's shape (docs-app.ts: the memory store, `mcp` offering one
 * plugin's tools, each plugin from its own entry point) runs in a process of its own on this
 * runtime, Deno or Node, and stays within bounds: RSS and heap used after a full GC once started,
 * the heap each MCP call keeps over a short run, and RSS after it. Nothing in it resolves a model,
 * so the model catalog (5 MiB of heap) is never loaded.
 *
 * The bounds (below) are generous, so they catch a real regression (a leak, a module graph that
 * doubled), not noise. It takes a few seconds. The memory harness this comes from says where
 * memory goes in detail, scenario by scenario; docs/operations/memory.md has what it found.
 */
import { assert, assertEquals } from "@std/assert";
import { execFile } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runtime, test } from "../../testing/mod.ts";

// deno-lint-ignore no-explicit-any
const g = globalThis as any;
const MiB = 1024 * 1024;
const CALLS = 200;

/**
 * The bounds, about twice what it measured (2026-11-12, a Mac; Node runs the TypeScript as it is,
 * which costs it ~25 MiB): MiB of RSS and heap used after a full GC once started and called once,
 * KiB of heap each call keeps (calls 50 to 200: the memory store keeps every event), and MiB of
 * RSS after the 200 calls.
 *
 *         started RSS   heap   KiB a call   RSS after
 *   Deno       90       11.8      36–41       170
 *   Node      128       18.4      19          225–254
 */
const BUDGET = {
  deno: { rss: 180, heap: 24, perCall: 80, rssAfter: 340 },
  node: { rss: 256, heap: 36, perCall: 48, rssAfter: 500 },
};

type Reading = { rss: number; heapUsed: number };
type Measured = {
  calls: number;
  warm: number;
  failed: number;
  catalogLoaded: boolean;
  loaded: Reading;
  started: Reading;
  warmed: Reading;
  end: Reading;
};

/** docs-app.ts in a child process of this runtime, with the GC exposed: what it measured. */
function measure(): Promise<Measured> {
  const script = fileURLToPath(new URL("./docs-app.ts", import.meta.url));
  const [exec, ...argv] = runtime === "deno"
    ? [g.Deno.execPath(), "run", "-A", "--v8-flags=--expose-gc", script, String(CALLS)]
    : [
      process.execPath,
      "--expose-gc",
      "--disable-warning=ExperimentalWarning",
      script,
      String(CALLS),
    ];
  return new Promise((resolve, reject) =>
    execFile(exec, argv, { maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`docs-app.ts failed: ${error.message}\n${stderr}`));
      resolve(JSON.parse(stdout.trim().split("\n").at(-1)!));
    })
  );
}

test({
  name: "the docs app's shape stays within its memory budget, and never loads the model catalog",
  // Bun's heap is JavaScriptCore's: these bounds are V8's.
  ignore: runtime === "bun",
  fn: async () => {
    const budget = BUDGET[runtime as "deno" | "node"];
    const m = await measure();
    const mib = (bytes: number) => Math.round(bytes / MiB * 10) / 10;
    const perCall = (m.end.heapUsed - m.warmed.heapUsed) / (m.calls - m.warm) / 1024;
    const said = `${runtime}: started ${mib(m.started.rss)} MiB RSS, ${
      mib(m.started.heapUsed)
    } MiB heap; ${perCall.toFixed(1)} KiB heap a call; ${mib(m.end.rss)} MiB RSS after ${m.calls}`;
    assertEquals(m.failed, 0, said);
    assertEquals(m.catalogLoaded, false, `the model catalog was loaded (${said})`);
    assert(m.started.rss <= budget.rss * MiB, `RSS over ${budget.rss} MiB: ${said}`);
    assert(m.started.heapUsed <= budget.heap * MiB, `heap over ${budget.heap} MiB: ${said}`);
    assert(perCall <= budget.perCall, `over ${budget.perCall} KiB of heap a call: ${said}`);
    assert(m.end.rss <= budget.rssAfter * MiB, `RSS over ${budget.rssAfter} MiB: ${said}`);
  },
});
