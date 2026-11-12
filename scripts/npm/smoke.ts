/**
 * The npm package as an app gets it: `dist/npm/` packed, installed from the
 * tarball into a new Node project in a temporary folder, and used there by its
 * names (`copilotz`, `copilotz/stores/memory`, …), never by its files.
 *
 * - **An app:** a runtime with the memory store, chat and the fake model,
 *   sends a message and reads the reply; again on PostgreSQL, in a schema of
 *   its own that it drops after, when `COPILOTZ_TEST_POSTGRES_URL` is set.
 * - **AGENTS.md**, the guide for an app's coding agent, is in the installed
 *   package.
 * - **Every entry point** loads on Node, and the app and all of them
 *   type-check against the package's declarations (`skipLibCheck: false`).
 * - **The browser's code** bundles from the installed package
 *   (`copilotz/web/node`'s `bundle`), split as on Deno.
 * - **The product packages** built beside it (`dist/packages/<name>/`, by
 *   `npm run build`), when there are: packed and installed with it, together,
 *   from their tarballs; an org's runtime with a plugin of each (a board, an
 *   agent made there, the org's credits) and a directory's beside it; their
 *   entry points loaded and type-checked with Copilotz's, and their front ends
 *   bundled in the same page. One `copilotz` is installed, theirs and the app's.
 *
 *   npm run build && node scripts/npm/smoke.ts [--ominipg=path/to/ominipg-x.y.z.tgz]
 *
 * `--ominipg` installs Ominipg from a tarball. Without it, Ominipg comes from
 * npm, or, while the version the package names isn't there yet, from JSR's
 * npm registry (`@jsr/oxian__ominipg`, the same code), as this repo installs it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIST = join(ROOT, "dist", "npm");
const ominipg = process.argv.find((arg) => arg.startsWith("--ominipg="))?.slice(10);
const postgres = process.env.COPILOTZ_TEST_POSTGRES_URL;
const windows = process.platform === "win32";

if (!existsSync(join(DIST, "package.json"))) {
  console.error("smoke: no dist/npm/ yet: npm run build first");
  process.exit(1);
}
type Manifest = { name: string; version: string; exports: Record<string, unknown> };
const manifest = JSON.parse(readFileSync(join(DIST, "package.json"), "utf8")) as Manifest;

/** The product packages built beside it, by folder (`work`: `@copilotz/work`). */
const BUILT = join(ROOT, "dist", "packages");
const packages = (existsSync(BUILT) ? readdirSync(BUILT) : [])
  .filter((name) => existsSync(join(BUILT, name, "package.json"))).sort()
  .map((name) => ({
    dir: join(BUILT, name),
    manifest: JSON.parse(readFileSync(join(BUILT, name, "package.json"), "utf8")) as Manifest,
  }));
/** Those the app below uses, one plugin of each. */
const PRODUCTS = ["@copilotz/billing", "@copilotz/directory", "@copilotz/team", "@copilotz/work"];
if (packages.length) {
  const names = packages.map((p) => p.manifest.name);
  const missing = PRODUCTS.filter((name) => !names.includes(name));
  if (missing.length) {
    console.error(`smoke: dist/packages/ has no ${missing.join(", ")}: npm run build first`);
    process.exit(1);
  }
  const other = packages.find((p) => p.manifest.version !== manifest.version);
  if (other) {
    console.error(
      `smoke: ${other.manifest.name} is ${other.manifest.version}, copilotz ${manifest.version}`,
    );
    process.exit(1);
  }
}
const run = (command: string, args: string[], cwd: string) =>
  execFileSync(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"], shell: windows })
    .toString();
const step = (what: string) => console.log(`smoke: ${what}`);

/** The devDependencies the checks use, at the versions this repo builds with. */
const dev = (() => {
  const { devDependencies } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const pick = ["typescript", "esbuild", "@types/node", "@types/react"];
  return Object.fromEntries(pick.map((name) => [name, devDependencies[name]]));
})();

const APP = `import { createRuntime, definePlugin } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { postgresStore } from "copilotz/stores/postgres";
import { models } from "copilotz/plugins/models";
import { chat, type Message } from "copilotz/plugins/agents";

const url = process.argv[2];
const schema = \`npm_smoke_\${crypto.randomUUID().slice(0, 8)}\`;
const postgres = url ? await postgresStore({ url, schema }) : undefined;
// Closing the runtime closes its store: a Postgres one drops its schema first.
const store = postgres ? Object.assign(postgres, { close: () => postgres.drop() }) : memoryStore();
const app = definePlugin({
  name: "app",
  resources: { agents: { assistant: { default: true, instructions: "Be brief.", model: "fake/echo" } } },
});
const runtime = await createRuntime({ store, plugins: [models, chat, app] });
const { thread } = await runtime.call<{ thread: string }>("chat.send", { text: "hello", from: "ana" });
await runtime.idle();
const messages = await runtime.query<Message[]>("message.history", { thread });
await runtime.close();
const reply = messages.find((m) => m.from === "assistant");
if (!reply?.text?.includes("hello")) throw new Error(\`no reply: \${JSON.stringify(messages)}\`);
console.log(\`  \${url ? "postgres" : "memory"}: \${reply.from}: \${reply.text}\`);
`;

const BROWSER = `import { web } from "copilotz/web";
import { webShell } from "copilotz/plugins/interfaces/web";
import { chatWeb, memoryWeb } from "copilotz/plugins/agents/web";
import { spacesWeb } from "copilotz/plugins/access/web";
import { computersWeb } from "copilotz/plugins/compute/web";
${
  packages.length
    ? `import { boardsWeb, documentsWeb } from "@copilotz/work/web";
import { directoryWeb } from "@copilotz/directory/web";
import { creditsWeb } from "@copilotz/billing/web";
import { teamWeb, tiersWeb } from "@copilotz/team/web";
`
    : ""
}
await web({
  root: document.getElementById("app")!,
  plugins: [webShell, chatWeb, spacesWeb, memoryWeb, computersWeb${
  packages.length ? ", boardsWeb, documentsWeb, directoryWeb, creditsWeb, teamWeb, tiersWeb" : ""
}],
});
`;

/**
 * An org's runtime with a plugin of each product package, and a directory's: a board in Ana's
 * space, an agent she makes there, her org's credits, and a team org in the directory.
 */
const PRODUCTS_APP = `import { type Actor, createRuntime, definePlugin } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { models } from "copilotz/plugins/models";
import { chat } from "copilotz/plugins/agents";
import { access, identity } from "copilotz/plugins/access";
import { usage } from "copilotz/plugins/billing";
import { boards, documents } from "@copilotz/work";
import { team, tiers } from "@copilotz/team";
import { credits } from "@copilotz/billing";
import { directory } from "@copilotz/directory";

const app = definePlugin({
  name: "app",
  resources: {
    agents: { assistant: { default: true, instructions: "Be brief.", model: "fake/echo" } },
    billing: { plans: { free: { title: "Free" } } },
  },
});
const org = await createRuntime({
  store: memoryStore(),
  plugins: [models, chat, ...access, usage, credits, team, tiers, boards, documents, app],
});
const ana: Actor = { kind: "person", id: "ana" };
const { space } = await org.call<{ space: string }>("space.personal", {}, { actor: ana });
const { board } = await org.call<{ board: string }>("board.create", { in: space, name: "Launch" }, {
  actor: ana,
});
const { agent } = await org.call<{ agent: string }>("agent.create", {
  in: space,
  name: "Maya",
  instructions: "I write.",
}, { actor: ana });
const spend = await org.call<{ ok: boolean }>("billing.check", {});
await org.close();
const dir = await createRuntime({ store: memoryStore(), plugins: [identity, directory] });
const made = await dir.call<{ org: string }>("org.create", { name: "Acme", by: "ana" });
await dir.close();
if (!board || agent !== "maya" || typeof spend.ok !== "boolean" || !made.org) {
  throw new Error(\`not as made: \${JSON.stringify({ board, agent, spend, made })}\`);
}
console.log(\`  a board, an agent (@\${agent}), the org's credits (ok: \${spend.ok}), an org (\${made.org})\`);
`;

const BUNDLE = `import { bundle } from "copilotz/web/node";

const code = await bundle(new URL("./browser.tsx", import.meta.url));
const sizes = Object.entries(code.files).map(([name, text]) => \`\${name} \${Math.round(text.length / 1024)} KB\`);
if (Object.keys(code.files).length < 2) throw new Error("the browser's code wasn't split");
console.log(\`  \${code.entry}: \${sizes.join(", ")}\`);
`;

/** Every entry point, by its name, loaded: each must load on Node, and type-check. */
const names = [manifest, ...packages.map((p) => p.manifest)].flatMap((m) =>
  Object.keys(m.exports).filter((name) => name !== "./package.json")
    .map((name) => m.name + name.slice(1))
);
const SURFACE = [
  ...names.map((name, i) => `import * as e${i} from "${name}";`),
  `const loaded = [${names.map((_, i) => `e${i}`).join(", ")}];`,
  `console.log(\`  \${loaded.length} entry points loaded\`);`,
].join("\n");

const TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    lib: ["ES2024", "DOM", "DOM.Iterable"],
    types: ["node"],
    jsx: "react-jsx",
    strict: true,
    noEmit: true,
    skipLibCheck: false,
  },
  include: ["*.ts", "*.tsx"],
};

/** Where Ominipg comes from: a tarball given, npm, or JSR's npm registry until it's on npm. */
const ominipgFrom = (() => {
  if (ominipg) return `file:${resolve(ominipg)}`;
  const version = (manifest as { dependencies?: Record<string, string> }).dependencies?.ominipg;
  if (!version) return undefined;
  try {
    execFileSync("npm", ["view", `ominipg@${version}`, "version"], {
      stdio: "ignore",
      shell: windows,
    });
    return undefined;
  } catch {
    console.log(`smoke: ominipg@${version} isn't on npm yet; installing it from JSR's registry`);
    return `npm:@jsr/oxian__ominipg@${version}`;
  }
})();

const dir = mkdtempSync(join(tmpdir(), "copilotz-npm-"));
try {
  /** A built package, packed into the project's folder: its tarball's name. */
  const pack = (from: string, m: Manifest) => {
    step(`packing ${m.name}@${m.version}`);
    const [packed] = JSON.parse(
      run("npm", ["pack", from, "--pack-destination", dir, "--json", "--silent"], ROOT),
    ) as { filename: string }[];
    return packed.filename;
  };
  const tarball = pack(DIST, manifest);
  const products = Object.fromEntries(
    packages.map((p) => [p.manifest.name, `file:./${pack(p.dir, p.manifest)}`]),
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "copilotz-npm-smoke",
        private: true,
        type: "module",
        dependencies: { [manifest.name]: `file:./${tarball}`, ...products },
        devDependencies: dev,
        ...(ominipgFrom ? { overrides: { ominipg: ominipgFrom } } : {}),
      },
      null,
      2,
    ),
  );
  if (ominipgFrom?.startsWith("npm:@jsr/")) {
    writeFileSync(join(dir, ".npmrc"), "@jsr:registry=https://npm.jsr.io\n");
  }
  writeFileSync(join(dir, "app.ts"), APP);
  if (packages.length) writeFileSync(join(dir, "products.ts"), PRODUCTS_APP);
  writeFileSync(join(dir, "browser.tsx"), BROWSER);
  writeFileSync(join(dir, "bundle.ts"), BUNDLE);
  writeFileSync(join(dir, "surface.ts"), SURFACE);
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(TSCONFIG, null, 2));

  step(`installing ${packages.length ? "them, together," : "it"} into a new project`);
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], dir);
  // The guide for an app's coding agent, where it looks: in the installed package.
  if (!existsSync(join(dir, "node_modules", ...manifest.name.split("/"), "AGENTS.md"))) {
    throw new Error(`the installed ${manifest.name} has no AGENTS.md`);
  }
  if (packages.length) {
    // One Copilotz, the app's: each package's is it (a peer at the same version), not a copy.
    const copies = packages.filter((p) =>
      existsSync(
        join(dir, "node_modules", ...p.manifest.name.split("/"), "node_modules", "copilotz"),
      )
    );
    if (copies.length) {
      throw new Error(`a copilotz of their own: ${copies.map((p) => p.manifest.name)}`);
    }
    step("the product packages: a plugin of each, in an org's runtime and a directory's");
    process.stdout.write(run("node", ["products.ts"], dir));
  }
  step("an app: chat, the fake model, the memory store");
  process.stdout.write(run("node", ["app.ts"], dir));
  if (postgres) {
    step("the same app on PostgreSQL");
    process.stdout.write(run("node", ["app.ts", postgres], dir));
  }
  step("every entry point");
  process.stdout.write(run("node", ["surface.ts"], dir));
  step("their types, with the app's");
  run("npx", ["tsc", "-p", "."], dir);
  step("the browser's code, bundled from the package");
  process.stdout.write(run("node", ["bundle.ts"], dir));
  console.log("smoke: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
