import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { specifier } from "../cli/folders.ts";
import { template } from "../cli/template.ts";
import { runtime, tempDir, test } from "./mod.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "cli", "mod.ts");
const fixture = join(root, "testing", "fixtures", "compiler");
const args = runtime === "deno"
  ? ["run", "-A", "--cached-only", "--node-modules-dir=manual", cli]
  : [cli];
const read = (dir: string, path: string) =>
  readFileSync(join(dir, path), "utf8").replaceAll("\r\n", "\n");

function app(copy = true) {
  const dir = tempDir();
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "junction");
  if (copy) {
    cpSync(fixture, dir, { recursive: true });
    const files = template("local");
    for (const name of ["tsx.ts", "tsx-hooks.ts", "tsconfig.json"]) {
      writeFileSync(join(dir, name), files[name]);
    }
  }
  return dir;
}

function run(dir: string, command: string, args: string[], fails = false) {
  const child = spawnSync(command, args, { cwd: dir, encoding: "utf8" });
  if (child.error) throw child.error;
  const output = child.stdout + child.stderr;
  if (fails) assert.notEqual(child.status, 0, output);
  else assert.equal(child.status, 0, output);
  return output;
}

const gen = (dir: string, flags: string[] = [], fails = false) =>
  run(dir, process.execPath, [...args, "gen", ...flags], fails);
const verify = (dir: string) =>
  run(
    dir,
    process.execPath,
    runtime === "deno" ? [...args.slice(0, -1), "verify.ts"] : ["verify.ts"],
  );
const tsc = (dir: string, fails = false) =>
  run(dir, "node", [join(root, "node_modules/typescript/bin/tsc"), "--noEmit"], fails);
const host = ".copilotz/build/plugins/orders";

test("gen assembles each host and gets the names of the composed app, including hand-written plugins", () => {
  const dir = app();
  gen(dir);
  for (const entry of ["mod", "web", "terminal"]) {
    assert.equal(
      read(dir, host + "/" + entry + ".ts"),
      read(fixture, "snapshots/" + entry + ".snap"),
    );
  }
  assert.equal(read(dir, "copilotz-env.d.ts"), read(fixture, "snapshots/names.snap"));
  assert.ok(!existsSync(join(dir, ".copilotz/build/plugins/manual")));
  assert.equal(
    specifier("..\\..\\plugins\\orders\\actions\\order.ship.ts"),
    "../../plugins/orders/actions/order.ship.ts",
  );
  tsc(dir);
  verify(dir);
  writeFileSync(
    join(dir, "typo.ts"),
    'import type { Runtime } from "copilotz";\ndeclare const r: Runtime;\nr.call("oder.ship");\n',
  );
  assert.match(tsc(dir, true), /oder.ship/);
});

test("check catches stale, missing and extra output without writing, and reports invalid input files", () => {
  const dir = app();
  gen(dir);
  const names = read(dir, "copilotz-env.d.ts");
  writeFileSync(join(dir, "copilotz-env.d.ts"), "// old");
  assert.match(gen(dir, ["--check"], true), /copilotz-env.d.ts/);
  assert.equal(read(dir, "copilotz-env.d.ts"), "// old");
  gen(dir);
  assert.equal(read(dir, "copilotz-env.d.ts"), names);
  rmSync(join(dir, host, "web.ts"));
  assert.match(gen(dir, ["--check"], true), /web.ts/);
  assert.ok(!existsSync(join(dir, host, "web.ts")));
  gen(dir);
  writeFileSync(join(dir, host, "old.ts"), "");
  assert.match(gen(dir, ["--check"], true), /old.ts/);
  gen(dir);
  assert.ok(!existsSync(join(dir, host, "old.ts")));
  for (const path of ["actions/ship.ts", "collections/README.md", "adapters/local.ts"]) {
    const file = join(dir, "plugins/orders", path);
    writeFileSync(file, "");
    assert.match(gen(dir, ["--check"], true), /Unexpected declaration/);
    rmSync(file);
  }
  writeFileSync(
    join(dir, "plugins/orders/views/web/screen/orders.tsx"),
    "export const screen = 1;",
  );
  assert.match(gen(dir, ["--check"], true), /default/i);
});

test("check detects a changed type and schema diagnostics leave all generated files alone", () => {
  const dir = app();
  gen(dir);
  const mod = host + "/mod.ts";
  const before = read(dir, mod);
  const contract = "plugins/orders/contract.ts";
  const original = read(dir, contract);
  writeFileSync(join(dir, contract), original.replace("@minimum 1", "@minimum 3"));
  assert.match(gen(dir, ["--check"], true), /mod.ts is stale/);
  assert.equal(read(dir, mod), before);
  gen(dir);
  assert.match(read(dir, mod), /"minimum": 3/);
  const extra = join(dir, host, "unreconciled.ts");
  writeFileSync(extra, "");
  writeFileSync(join(dir, contract), original.replace("quantity: number", "quantity: Date"));
  for (const flags of [[], ["--eject", "orders"]]) {
    const output = gen(dir, flags, true);
    assert.match(output, /invoice.issue.ts: input.quantity: Date/);
    assert.match(output, /invoice.ts: schema.quantity: Date/);
    assert.ok(existsSync(extra));
    assert.match(read(dir, mod), /"minimum": 3/);
    assert.ok(!existsSync(join(dir, "plugins/orders/mod.ts")));
  }
});

test("eject keeps the app's imports working and gen leaves both hand-written plugins alone", () => {
  const dir = app();
  gen(dir);
  gen(dir, ["--eject", "orders"]);
  const path = "plugins/orders/mod.ts";
  assert.match(read(dir, path), /from "\.\/actions\/order.ship.ts"/);
  assert.ok(!existsSync(join(dir, host)));
  const names = statSync(join(dir, "copilotz-env.d.ts")).mtimeMs;
  const ejected = statSync(join(dir, path)).mtimeMs;
  gen(dir);
  gen(dir, ["--check"]);
  assert.equal(statSync(join(dir, "copilotz-env.d.ts")).mtimeMs, names);
  assert.equal(statSync(join(dir, path)).mtimeMs, ejected);
  tsc(dir);
  verify(dir);
});

test("watch reloads the app's imported collection when its query changes", async () => {
  const dir = app();
  const child = spawn(process.execPath, [...args, "gen", "--watch"], { cwd: dir, stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const waitFor = async (word: string, output = "copilotz-env.d.ts") => {
    const file = join(dir, output);
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      if (existsSync(file) && readFileSync(file, "utf8").includes(word)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail("watch did not generate " + word);
  };
  try {
    await waitFor("order.pending");
    const path = "plugins/orders/collections/order.ts";
    writeFileSync(join(dir, path), read(dir, path).replace("pending:", "unshipped:"));
    await waitFor("order.unshipped");
    const contract = "plugins/orders/contract.ts";
    const source = read(dir, contract);
    writeFileSync(join(dir, "invoice.ts"), source);
    writeFileSync(join(dir, contract), 'export type { Invoice, OrderId } from "../../invoice.ts";');
    writeFileSync(join(dir, "invoice.ts"), source.replace("@minimum 1", "@minimum 4"));
    await waitFor('"minimum": 4', host + "/mod.ts");
    writeFileSync(join(dir, "invoice.ts"), source.replace("@minimum 1", "@minimum 5"));
    await waitFor('"minimum": 5', host + "/mod.ts");
  } finally {
    child.kill();
    await exited;
  }
});

test("init uses the linked local package offline and makes a working checked TypeScript app", () => {
  const dir = app(false);
  run(dir, process.execPath, [...args, "init", dir]);
  gen(dir, ["--check"]);
  tsc(dir);
  run(dir, "node", ["--import", "./tsx.ts", "--test", "tests/orders.test.ts"]);
  assert.match(run(dir, process.execPath, [...args, "init"], true), /empty directory/);
});

test("the npm entry dispatches through a symlink on early Node 24 and stays inert on import", () => {
  const dir = app(false);
  const entry = join(dir, "copilotz.ts");
  // Windows npm uses a command shim, while POSIX uses a file symlink.
  const bin = process.platform === "win32" ? cli : entry;
  if (bin === entry) symlinkSync(cli, entry, "file");
  // Run the installed entry's code with the same missing metadata as Node 24.0 and 24.1.
  const hook = join(dir, "early-node.mjs");
  writeFileSync(
    hook,
    `import { registerHooks } from "node:module";
    registerHooks({load(url, context, next) {
      const loaded = next(url, context);
      if (url === ${JSON.stringify(new URL("../cli/mod.ts", import.meta.url).href)}) {
        return {...loaded, source: String(loaded.source).replaceAll("import.meta.main", "undefined")};
      }
      return loaded;
    }});`,
  );
  assert.match(run(dir, "node", ["--import", hook, bin, "unknown"], true), /Usage: copilotz/);
  const importer = join(dir, "import.mjs");
  writeFileSync(
    importer,
    `import ${JSON.stringify(new URL("../cli/mod.ts", import.meta.url).href)};`,
  );
  run(dir, "node", ["--import", hook, importer, "unknown"]);
});
