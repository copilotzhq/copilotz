import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  inspectOxianRevision,
  parseOwnerConnectedArgs,
  prepareOwnerConnectedTest,
  runOwnerConnectedTests,
} from "./test-owner-connected.mjs";

const execute = promisify(execFile);
const script = fileURLToPath(
  new URL("./test-owner-connected.mjs", import.meta.url),
);
const pin = "jsr:@oxian/oxian-js@0.21.2";
const sourceFiles = [
  "src/hypervisor/index.ts",
  "src/worker/index.ts",
  "src/adapters/node/index.ts",
  "src/work/host-call-channel.ts",
];
const exports = {
  "./hypervisor": "./src/hypervisor/index.ts",
  "./worker": "./src/worker/index.ts",
  "./adapters/node": "./src/adapters/node/index.ts",
};
async function put(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    typeof content === "string" ? content : JSON.stringify(content),
  );
}
async function fixture(
  run: (paths: {
    temporary: string;
    root: string;
    source: string;
  }) => Promise<void>,
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "copilotz-sibling-setup-"));
  const root = join(temporary, "copilotz # space");
  const source = join(temporary, "Oxian ü # sibling");
  try {
    await put(join(root, "deno.json"), {
      name: "@copilotz/copilotz",
      imports: {
        "@copilotz/copilotz": "./index.ts",
        "@copilotz/copilotz/": "./",
        "@oxian/oxian-js": pin,
        "@std/path": "jsr:@std/path@1",
      },
      scopes: { "./runtime/": { local: "./runtime/local.ts" } },
      unstable: ["sloppy-imports"],
      lock: false,
    });
    await put(
      join(root, "runtime/execution/owner-connected.integration.test.ts"),
      "// Fixture setup only.",
    );
    await put(
      join(root, "runtime/execution/owner-capabilities.test.ts"),
      "// Execution fixture setup only.",
    );
    for (
      const path of [
        "runtime/application/topology.test.ts",
        "runtime/application/worker-owner.test.ts",
        "build/role-bundle.connected.test.ts",
      ]
    ) await put(join(root, path), "// Host/provider fixture setup only.");
    await put(join(source, "deno.json"), {
      name: "@oxian/oxian-js",
      exports,
      imports: { ws: "npm:ws@8.22.0", "@std/path": "jsr:@std/path@1.1.1" },
      scopes: { "./src/work/": { local: "./src/work/local.ts" } },
    });
    for (const path of sourceFiles) {
      await put(join(source, path), "// Selected fixture source.");
    }
    await run({ temporary, root, source });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("sibling runner requires explicit source and rejects malformed or repeated options", () => {
  assert.throws(
    () => parseOwnerConnectedArgs([], {}),
    /Select an Oxian source checkout/,
  );
  for (
    const args of [["--oxian-source"], ["--other"], ["--deno", "--help"], [
      "--oxian-source",
      "a",
      "--oxian-source",
      "b",
    ]]
  ) {
    assert.throws(() => parseOwnerConnectedArgs(args, {}));
  }
  assert.deepEqual(parseOwnerConnectedArgs(["--help"], {}), { help: true });
  assert.deepEqual(
    parseOwnerConnectedArgs([], { COPILOTZ_OXIAN_SOURCE_ROOT: "sibling path" }),
    {
      help: false,
      source: "sibling path",
      deno: "deno",
    },
  );
  assert.deepEqual(
    parseOwnerConnectedArgs([
      "--oxian-source",
      "chosen",
      "--deno",
      "/runtime with spaces/deno",
    ], {
      COPILOTZ_OXIAN_SOURCE_ROOT: "ignored",
    }),
    { help: false, source: "chosen", deno: "/runtime with spaces/deno" },
  );
});

test("setup resolves relative paths and scoped sibling imports without changing published pins", async () => {
  await fixture(async ({ temporary, root, source }) => {
    const before = await readFile(join(root, "deno.json"), "utf8");
    const plan = await prepareOwnerConnectedTest({
      source: relative(temporary, source),
      root,
      cwd: temporary,
    });
    const sourceScope = pathToFileURL(source + sep).href;
    assert.equal(plan.sourceRoot, source);
    assert.equal(plan.config.imports["@oxian/oxian-js"], pin);
    assert.equal(plan.config.imports["@std/path"], "jsr:@std/path@1");
    assert.equal(
      plan.config.imports["@copilotz/copilotz"],
      pathToFileURL(join(root, "index.ts")).href,
    );
    assert.equal(
      plan.config.imports["@copilotz/copilotz/"],
      pathToFileURL(root + sep).href,
    );
    assert.equal(Object.hasOwn(plan.config.imports, "ws"), false);
    assert.equal(plan.testFiles.length, 5);
    assert.equal(
      plan.config.imports["@oxian/oxian-js/worker"],
      new URL("src/worker/index.ts", sourceScope).href,
    );
    // Preserve the Copilotz facade (and its local type aliases); only its
    // package import resolves to the selected Oxian source.
    for (
      const path of [
        "runtime/application/worker.ts",
        "runtime/execution/owner-capability-worker.ts",
      ]
    ) {
      assert.equal(
        plan.config.scopes[pathToFileURL(join(root, path)).href],
        undefined,
      );
    }
    assert.deepEqual(plan.config.scopes[sourceScope], {
      ws: "npm:ws@8.22.0",
      "@std/path": "jsr:@std/path@1.1.1",
    });
    assert.equal(
      plan.config.scopes[new URL("src/work/", sourceScope).href].local,
      pathToFileURL(join(source, "src/work/local.ts")).href,
    );
    assert.equal(
      plan.config.scopes[pathToFileURL(join(root, "runtime") + sep).href].local,
      pathToFileURL(join(root, "runtime/local.ts")).href,
    );
    assert.equal(plan.config.lock, false);
    assert.equal(await readFile(join(root, "deno.json"), "utf8"), before);
  });
});

test("setup refuses unavailable sources, wrong packages and missing reverse-call source", async () => {
  await fixture(async ({ temporary, root, source }) => {
    await assert.rejects(
      prepareOwnerConnectedTest({ source: join(temporary, "absent"), root }),
      /source checkout is unavailable/,
    );
    const manifest = join(source, "deno.json");
    const before = await readFile(manifest, "utf8");
    await put(manifest, { name: "different-package" });
    await assert.rejects(
      prepareOwnerConnectedTest({ source, root }),
      /name mismatch/,
    );
    await put(manifest, before);
    await rm(join(source, "src/work/host-call-channel.ts"));
    await assert.rejects(
      prepareOwnerConnectedTest({ source, root }),
      /missing required source file src\/work\/host-call-channel.ts/,
    );
  });
});

test("setup requires the selected sibling's exact ws pin instead of inventing a dependency", async () => {
  await fixture(async ({ root, source }) => {
    for (
      const value of [
        undefined,
        "npm:ws@^8.22.0",
        "npm:ws@latest",
        "../different/node_modules/ws/index.js",
      ]
    ) {
      for (
        const path of [
          "runtime/application/owner-host.test.ts",
          "runtime/application/owner-host.processor.test.ts",
          "runtime/application/owner-host.capacity.test.ts",
          "plugins/channel-telegram/actions/send-text/transport.integration.test.ts",
        ]
      ) await put(join(root, path), "// Host/provider fixture setup only.");
      await put(join(source, "deno.json"), {
        name: "@oxian/oxian-js",
        exports,
        imports: { ws: value },
      });
      await assert.rejects(
        prepareOwnerConnectedTest({ source, root }),
        /must pin ws exactly/,
      );
    }
  });
});

test("setup validates public export entries and rejects malformed manifests or escaping scopes", async () => {
  await fixture(async ({ root, source }) => {
    const manifestPath = join(source, "deno.json");
    const original = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const target of [undefined, "npm:other-package", "../outside.ts"]) {
      await put(manifestPath, {
        ...original,
        exports: { ...exports, "./worker": target },
      });
      await assert.rejects(
        prepareOwnerConnectedTest({ source, root }),
        /must declare local export '.\/worker'/,
      );
    }
    await put(manifestPath, {
      ...original,
      scopes: { "../": { ws: "npm:ws@9.0.0" } },
    });
    await assert.rejects(
      prepareOwnerConnectedTest({ source, root }),
      /scopes must stay inside/,
    );
    await put(manifestPath, "{malformed JSON");
    await assert.rejects(
      prepareOwnerConnectedTest({ source, root }),
      /Cannot read Oxian manifest/,
    );
  });
});

test("setup rejects source-file symlinks escaping the selected checkout", {
  skip: process.platform === "win32",
}, async () => {
  await fixture(async ({ temporary, root, source }) => {
    const outside = join(temporary, "outside.ts");
    await put(outside, "// Not the selected sibling source.");
    const target = join(source, sourceFiles[0]);
    await rm(target);
    await symlink(outside, target);
    await assert.rejects(
      prepareOwnerConnectedTest({ source, root }),
      /escapes the selected checkout/,
    );
  });
});

test("a source archive nested in an unrelated checkout cannot claim its enclosing revision", async () => {
  await fixture(async ({ temporary, root, source }) => {
    const unrelated = join(temporary, "unrelated checkout");
    // Copy existing local Git history without creating commits or touching its source.
    await execute("git", [
      "clone",
      "--quiet",
      "--shared",
      "--no-checkout",
      "--",
      fileURLToPath(new URL("../", import.meta.url)),
      unrelated,
    ]);
    const archive = join(unrelated, "nested Oxian source archive");
    await cp(source, archive, { recursive: true });
    assert.equal(
      (await prepareOwnerConnectedTest({ source: archive, root })).sourceRoot,
      archive,
    );
    assert.equal(await inspectOxianRevision(archive), undefined);
    const actualCheckout = await inspectOxianRevision(unrelated);
    assert.match(actualCheckout?.head ?? "", /^[0-9a-f]{40,64}$/);
    assert.match(actualCheckout?.tree ?? "", /^[0-9a-f]{40,64}$/);
    assert.equal(actualCheckout?.dirty, true);
  });
});

test("runner selects exact source, uses argument arrays and cleans config after success or failure", async () => {
  await fixture(async ({ root, source }) => {
    const originals = await Promise.all(
      [root, source].map((dir) => readFile(join(dir, "deno.json"), "utf8")),
    );
    for (const status of [0, 7]) {
      let configPath = "";
      const result = await runOwnerConnectedTests({
        source,
        root,
        deno: "/runtime with spaces/deno",
      }, async (command, args, options) => {
        assert.equal(command, "/runtime with spaces/deno");
        assert.equal(options.cwd, root);
        assert.equal(options.env.COPILOTZ_OXIAN_SOURCE_ROOT, source);
        assert.deepEqual(args.slice(0, 2), ["test", "--config"]);
        assert.deepEqual(args.slice(3), [
          "--allow-all",
          join(root, "runtime/execution/owner-connected.integration.test.ts"),
          join(root, "runtime/execution/owner-capabilities.test.ts"),
          join(root, "runtime/application/topology.test.ts"),
          join(root, "runtime/application/worker-owner.test.ts"),
          join(root, "build/role-bundle.connected.test.ts"),
        ]);
        configPath = args[2];
        const config = JSON.parse(await readFile(configPath, "utf8"));
        assert.equal(config.imports["@oxian/oxian-js"], pin);
        assert.equal(
          config.scopes[pathToFileURL(source + sep).href].ws,
          "npm:ws@8.22.0",
        );
        assert.equal(configPath.startsWith(root + sep), false);
        assert.equal(configPath.startsWith(source + sep), false);
        return status;
      });
      assert.equal(result, status);
      await assert.rejects(stat(dirname(configPath)), { code: "ENOENT" });
    }
    assert.deepEqual(
      await Promise.all(
        [root, source].map((dir) => readFile(join(dir, "deno.json"), "utf8")),
      ),
      originals,
    );
  });
});

test("runner removes ephemeral config when starting the test runtime throws", async () => {
  await fixture(async ({ root, source }) => {
    let configPath = "";
    const failure = new Error("runtime could not start");
    await assert.rejects(
      runOwnerConnectedTests({ source, root }, (_command, args) => {
        configPath = args[2];
        return Promise.reject(failure);
      }),
      (error) => error === failure,
    );
    await assert.rejects(stat(dirname(configPath)), { code: "ENOENT" });
  });
});

test(
  "real child exit and termination propagate while ephemeral config is removed",
  { skip: process.platform === "win32" },
  async () => {
    await fixture(async ({ temporary, root, source }) => {
      const marker = join(temporary, "child-config-path.txt");
      for (
        const [action, status] of [
          ["process.exit(17)", 17],
          ['process.kill(process.pid, "SIGTERM")', 143],
        ] as const
      ) {
        // Node acts as a tiny test-runtime stand-in: its `test` argument is this file.
        await put(
          join(root, "test"),
          `require("node:fs").writeFileSync(${
            JSON.stringify(marker)
          }, process.argv[3]); ${action};`,
        );
        const messages: string[] = [];
        assert.equal(
          await runOwnerConnectedTests(
            { source, root, deno: "node" },
            undefined,
            (message: string) => messages.push(message),
          ),
          status,
        );
        const configPath = await readFile(marker, "utf8");
        await assert.rejects(stat(dirname(configPath)), { code: "ENOENT" });
        assert.ok(messages.includes(`Oxian fixture source: ${source}`));
        assert.ok(
          messages.some((message) =>
            message.includes("revision/tree/dirty status unavailable")
          ),
        );
      }
    });
  },
);

test("CLI fails clearly without selected source from an unrelated working directory", async () => {
  const env = { ...process.env };
  delete env.COPILOTZ_OXIAN_SOURCE_ROOT;
  await assert.rejects(
    execute("node", [script], { cwd: tmpdir(), env }),
    (error: unknown) => {
      const failure = error as { code: number; stderr: string };
      return failure.code === 1 &&
        /Select an Oxian source checkout/.test(failure.stderr);
    },
  );
  const result = await execute("node", [resolve(script), "--help"], {
    cwd: tmpdir(),
    env,
  });
  assert.match(result.stdout, /--oxian-source PATH/);
});
