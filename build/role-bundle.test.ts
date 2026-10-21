import { assert, assertEquals, assertRejects } from "@std/assert";
import { buildWorkerRole } from "./role-bundle.ts";

const packageRoot = new URL("../", import.meta.url);
async function fixture(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
) {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "role-fixture-" }),
  );
  try {
    for (const [path, text] of Object.entries(files)) {
      await Deno.writeTextFile(root + "/" + path, text);
    }
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
const core = (path: string) => new URL(path, packageRoot).href;

Deno.test("worker role audits root reexports and side effects before tree shaking", async () => {
  await fixture({
    "entry.ts": `import "@copilotz/copilotz";
      export {defineAction} from "@copilotz/copilotz";
      export {createCopilotz} from "@copilotz/copilotz/worker";`,
  }, async (root) => {
    const output = root + "/worker.js";
    const graph = await buildWorkerRole(root + "/entry.ts", { output });
    assert(graph.modules.some((m) => m.source === core("worker.ts")));
    assert(
      graph.modules.some((m) =>
        m.source === core("runtime/application/worker.ts")
      ),
    );
    assert(
      graph.modules.some((m) =>
        m.source === core("runtime/execution/owner-capability-worker.ts")
      ),
    );
    for (
      const path of [
        "runtime/execution/owner-capability-wire.ts",
        "runtime/execution/owner-capability-worker.ts",
        "runtime/execution/owner-capture.ts",
        "runtime/content/preparer.ts",
      ]
    ) {
      assert(graph.modules.some((module) => module.source === core(path)));
    }
    for (
      const path of [
        "runtime/owner/collection-read.ts",
        "runtime/owner/snapshot.ts",
        "runtime/owner/local-snapshot-port.ts",
        "runtime/owner/local-stream-port.ts",
        "runtime/owner/content-reservation.ts",
        "runtime/content/physical-body-store.ts",
        "runtime/content/database-physical-body-store.ts",
        "runtime/owner/ordinary-source-sql.ts",
        "runtime/collections/query.ts",
        "runtime/collections/aggregate.ts",
        "runtime/collections/read-budget.ts",
      ]
    ) {
      assert(!graph.modules.some((module) => module.source === core(path)));
    }

    assert(
      !graph.modules.some((m) =>
        /\/(persistence|engine|storage)\//.test(m.source)
      ),
    );
    assertEquals(graph.packages, []);
    for (const module of graph.modules) {
      assert(/^[a-f0-9]{64}$/.test(module.sha256));
    }
    for (const pkg of graph.packages) {
      assert(pkg.files.some((file) => file.path === "package.json"));
      for (const file of pkg.files) assert(/^[a-f0-9]{64}$/.test(file.sha256));
    }
    assertEquals(
      JSON.parse(await Deno.readTextFile(output + ".graph.json")),
      graph,
    );
    assertEquals(graph.artifact.platform, "browser");
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", await Deno.readFile(output)),
      ),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    assertEquals(graph.artifact.sha256, hash);
    const artifact = await import("file://" + output);
    assertEquals(typeof artifact.createCopilotz, "function");
    assertEquals(typeof artifact.defineAction, "function");
    // Loading the actual browser-target artifact has no runtime filesystem,
    // network, environment, subprocess, or native-library permission.
    const imported = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-config",
        "--deny-read",
        "--deny-write",
        "--deny-net",
        "--deny-env",
        "--deny-run",
        "--deny-ffi",
        output,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(imported.success, new TextDecoder().decode(imported.stderr));
  });
});

Deno.test("worker role erases type-only imports but retains empty executable imports", async () => {
  await fixture({
    "type.ts": `import type {SqlSession} from ${
      JSON.stringify(core("runtime/events/session.ts"))
    }; export type Session = SqlSession; export const valid = true;`,
    "empty.ts": `import {type SqlSession} from ${
      JSON.stringify(core("runtime/events/session.ts"))
    }; export type Session = SqlSession; export const valid = true;`,
  }, async (root) => {
    const graph = await buildWorkerRole(root + "/type.ts", {
      output: root + "/type.js",
    });
    assertEquals(graph.modules.length, 1);
    await assertRejects(
      () => buildWorkerRole(root + "/empty.ts", { output: root + "/empty.js" }),
      Error,
      "Unsupported worker runtime module: runtime/events/session.ts",
    );
  });
});

Deno.test("worker role refuses complete unsafe subpaths and unused runtime imports", async () => {
  for (
    const source of [
      'import "@copilotz/copilotz/persistence"; export const ok = true;',
      'export * from "@copilotz/copilotz/plugins";',
      'import {createCopilotzPersistence} from "@copilotz/copilotz/persistence"; export const unused = true;',
    ]
  ) {
    await fixture({ "entry.ts": source }, async (root) => {
      const output = root + "/worker.js";
      await Deno.writeTextFile(output, "previous artifact");
      await Deno.writeTextFile(output + ".graph.json", "previous graph");
      await assertRejects(
        () => buildWorkerRole(root + "/entry.ts", { output }),
        Error,
        "Unsupported worker runtime module:",
      );
      assertEquals(await Deno.readTextFile(output), "previous artifact");
      assertEquals(
        await Deno.readTextFile(output + ".graph.json"),
        "previous graph",
      );
    });
  }
});

Deno.test("worker role refuses self aliases and symlink disguises of owner modules", async () => {
  await fixture({
    "deno.json": JSON.stringify({ imports: { self: core("index.ts") } }),
    "entry.ts": 'import "self"; export const ok = true;',
  }, async (root) => {
    await assertRejects(
      () =>
        buildWorkerRole(root + "/entry.ts", { output: root + "/worker.js" }),
      Error,
      "Unsupported worker runtime module: index.ts",
    );
    await Deno.symlink(
      packageRoot,
      root + "/disguised",
    );
    await Deno.writeTextFile(
      root + "/entry.ts",
      'import "./disguised/runtime/events/session.ts"; export const ok = true;',
    );
    await assertRejects(
      () =>
        buildWorkerRole(root + "/entry.ts", { output: root + "/worker.js" }),
      Error,
      "Unsupported worker runtime module: runtime/events/session.ts",
    );
  });
});

Deno.test("worker role rejects literal and nonliteral dynamic loading", async () => {
  for (
    const source of [
      'export const load = () => import("@copilotz/copilotz/worker");',
      "export const load = (path: string) => import(path);",
      'const ASYNC_HOOKS_SPECIFIER = "node:async_hooks"; export const load = () => import(ASYNC_HOOKS_SPECIFIER);',
      'declare const require: (path: string) => unknown; export const load = () => require("ajv");',
    ]
  ) {
    await fixture({ "entry.ts": source }, async (root) => {
      await assertRejects(
        () =>
          buildWorkerRole(root + "/entry.ts", { output: root + "/worker.js" }),
        Error,
        "Dynamic worker module loading is unsupported",
      );
    });
  }
});

Deno.test("worker role refuses unapproved external runtime packages", async () => {
  await fixture({
    "entry.ts":
      'import {z} from "npm:zod@3.25.76"; export const schema = z.string();',
  }, async (root) => {
    await assertRejects(
      () =>
        buildWorkerRole(root + "/entry.ts", { output: root + "/worker.js" }),
      Error,
      "Unsupported worker npm entry:",
    );
  });
});

Deno.test("production bundle CLI emits the root-authored whole six-primitive plugin", async () => {
  await fixture({}, async (root) => {
    const output = root + "/whole.js";
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        new URL("index.ts", import.meta.url).pathname,
        "bundle",
        new URL("contracts/package/fixtures/owner-whole-plugin.ts", packageRoot)
          .pathname,
        "--role=worker",
        "--output=" + output,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
    const artifact = await import("file://" + output);
    assertEquals(typeof artifact.connect, "function");
    const native = await new Deno.Command("node", {
      args: [
        "--permission",
        "--allow-fs-read=" + output,
        "--input-type=module",
        "--eval",
        `import assert from "node:assert/strict";
         const artifact = await import(${JSON.stringify("file://" + output)});
         assert.equal(typeof artifact.connect, "function");
         for (const key of ["actions", "collections", "processors", "resources", "adapters", "views"]) assert.ok(Object.keys(artifact.plugin[key]).length);
         assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
         console.log("native-node-factory-artifact-ok:" + process.versions.node);`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(native.success, new TextDecoder().decode(native.stderr));
    assert(
      new TextDecoder().decode(native.stdout).startsWith(
        "native-node-factory-artifact-ok:",
      ),
    );
    for (
      const key of [
        "actions",
        "collections",
        "processors",
        "resources",
        "adapters",
        "views",
      ]
    ) assert(Object.keys(artifact.plugin[key]).length > 0, key);
    const graph = JSON.parse(await Deno.readTextFile(output + ".graph.json"));
    assertEquals(graph.role, "worker");
    assert(
      graph.modules.some((m: { source: string }) =>
        m.source === core("runtime/application/worker.ts")
      ),
    );
  });
});

Deno.test("worker publication preserves the prior artifact and evidence on every refusal", async () => {
  await fixture({ "entry.ts": "export const next = true;" }, async (root) => {
    const output = root + "/worker.js";
    await Deno.writeTextFile(output, "prior artifact");
    await Deno.mkdir(output + ".graph.json");
    await assertRejects(() => buildWorkerRole(root + "/entry.ts", { output }));
    assertEquals(await Deno.readTextFile(output), "prior artifact");
    await Deno.remove(output + ".graph.json");
    await Deno.writeTextFile(output + ".graph.json", "prior evidence");
    const rename = Deno.rename;
    let failed = false;
    Deno.rename = async (from, to) => {
      if (!failed && String(to) === output + ".graph.json") {
        failed = true;
        throw new Error("injected second publication failure");
      }
      return await rename(from, to);
    };
    try {
      await assertRejects(
        () => buildWorkerRole(root + "/entry.ts", { output }),
        Error,
        "injected second publication failure",
      );
    } finally {
      Deno.rename = rename;
    }
    assertEquals(await Deno.readTextFile(output), "prior artifact");
    assertEquals(
      await Deno.readTextFile(output + ".graph.json"),
      "prior evidence",
    );
  });
});

Deno.test("worker role snapshots static JSON and protects artifact/evidence source aliases", async () => {
  await fixture({
    "entry.ts":
      'import data from "./source.js.graph.json" with {type:"json"}; export default data;',
    "source.js.graph.json": '{"value":"retained source"}',
  }, async (root) => {
    const graph = await buildWorkerRole(root + "/entry.ts", {
      output: root + "/safe.js",
    });
    assertEquals(graph.modules.length, 2);
    assertEquals(
      (await import("file://" + root + "/safe.js")).default.value,
      "retained source",
    );
    await assertRejects(
      () =>
        buildWorkerRole(root + "/entry.ts", { output: root + "/source.js" }),
      Error,
      "must not overwrite",
    );
    assertEquals(
      await Deno.readTextFile(root + "/source.js.graph.json"),
      '{"value":"retained source"}',
    );
    await assertRejects(
      () => buildWorkerRole(root + "/entry.ts", { output: root + "/entry.ts" }),
      Error,
      "must not overwrite",
    );
  });
});

Deno.test("worker package loader supports only its local or pinned JSR config URL", async () => {
  const { readWorkerRolePackageConfig } = await import("./role-bundle.ts");
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input, options) => {
    requested.push(String(input));
    assertEquals(options?.redirect, "error");
    return await Promise.resolve(
      new Response(
        '{"name":"@copilotz/copilotz","exports":{"./worker":"./worker.ts"}}',
      ),
    );
  };
  try {
    const config = await readWorkerRolePackageConfig(
      new URL("https://jsr.io/@copilotz/copilotz/0.88.0/deno.json"),
    );
    assertEquals(config.name, "@copilotz/copilotz");
    assertEquals(requested, [
      "https://jsr.io/@copilotz/copilotz/0.88.0/deno.json",
    ]);
    for (
      const url of [
        "http://jsr.io/@copilotz/copilotz/0.88.0/deno.json",
        "https://example.com/@copilotz/copilotz/0.88.0/deno.json",
        "https://jsr.io/@copilotz/copilotz/latest/deno.json",
        "https://jsr.io/@copilotz/copilotz/0.88.0/other.json",
        "https://jsr.io/@copilotz/copilotz/0.88.0/deno.json?changed",
      ]
    ) {
      await assertRejects(
        () => readWorkerRolePackageConfig(new URL(url)),
        TypeError,
      );
    }
    assertEquals(requested.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("installed source artifact builds from its own complete worker package entry", async () => {
  await fixture({
    "entry.ts":
      'export {createCopilotz, defineAction, defineCollection, definePlugin, defineProcessor, defineView} from "@copilotz/copilotz";',
  }, async (root) => {
    const installed = root + "/installed";
    await Deno.mkdir(installed);
    const copy = async (relative: string): Promise<void> => {
      const source = new URL(relative, packageRoot);
      const info = await Deno.stat(source);
      if (info.isDirectory) {
        await Deno.mkdir(installed + "/" + relative, { recursive: true });
        for await (const item of Deno.readDir(source)) {
          if (
            item.name.includes(".test.") ||
            relative === "runtime" && item.name === "testing"
          ) continue;
          if (item.isDirectory || item.name.endsWith(".ts")) {
            await copy(relative + "/" + item.name);
          }
        }
      } else await Deno.copyFile(source, installed + "/" + relative);
    };
    for (
      const name of [
        "deno.json",
        "index.ts",
        "authoring.ts",
        "worker.ts",
        "create-copilotz.ts",
        "runtime",
        "dependencies",
        "plugins",
        "server",
        "client",
        "build",
      ]
    ) await copy(name);
    // Preserve an explicitly linked development cohort when relocating package
    // sources. Published configs have no links and require no rewriting.
    const copiedConfig = JSON.parse(
      await Deno.readTextFile(installed + "/deno.json"),
    );
    if (Array.isArray(copiedConfig.links)) {
      copiedConfig.links = copiedConfig.links.map((link: string) =>
        new URL(link, new URL("deno.json", packageRoot)).href.replace(/\/$/, "")
      );
      await Deno.writeTextFile(
        installed + "/deno.json",
        JSON.stringify(copiedConfig),
      );
    }
    const sourceArtifact = await import(
      "file://" + installed + "/build/role-bundle.ts"
    );
    const graph = await sourceArtifact.buildWorkerRole(root + "/entry.ts", {
      output: root + "/worker.js",
    });
    assert(
      graph.modules.some((m: { source: string }) =>
        m.source === "file://" + installed + "/worker.ts"
      ),
    );
    assert(
      !graph.modules.some((m: { source: string }) =>
        m.source.startsWith(packageRoot.href)
      ),
      "compiler did not leak back into checkout runtime",
    );
    const artifact = await import("file://" + root + "/worker.js");
    assertEquals(typeof artifact.createCopilotz, "function");
    assertEquals(typeof artifact.defineProcessor, "function");
  });
});

Deno.test("worker role refuses direct nested-worker and importScripts loaders", async () => {
  for (
    const source of [
      'export const load = () => new Worker(new URL("./hidden.ts", import.meta.url), {type:"module"});',
      'export const load = () => new globalThis.Worker(new URL("./hidden.ts", import.meta.url), {type:"module"});',
      'export const load = () => new (globalThis["Worker"])(new URL("./hidden.ts", import.meta.url), {type:"module"});',
      'export const load = () => new (globalThis[`Worker`])(new URL("./hidden.ts", import.meta.url), {type:"module"});',
      'declare const SharedWorker: new (path: string) => unknown; export const load = () => new SharedWorker("./hidden.ts");',
      'declare const window: { SharedWorker: new (path: string) => unknown }; export const load = () => new window.SharedWorker("./hidden.ts");',
      'declare const importScripts: (path: string) => void; export const load = () => importScripts("./hidden.ts");',
      'declare const self: {importScripts(path: string): void}; export const load = () => self.importScripts("./hidden.ts");',
      'export const load = () => (globalThis as unknown as {importScripts(path: string): void}).importScripts("./hidden.ts");',
    ]
  ) {
    await fixture({
      "entry.ts": source,
      "hidden.ts": 'import "@copilotz/copilotz/persistence";',
    }, async (root) => {
      await assertRejects(
        () =>
          buildWorkerRole(root + "/entry.ts", { output: root + "/worker.js" }),
        Error,
        "Nested worker module loading is unsupported",
      );
    });
  }
});
