/**
 * The npm package as an app gets it: `dist/npm/` packed, installed from the
 * tarball into a new Node project in a temporary folder, and used there by its
 * names (`copilotz`, `copilotz/stores/memory`, …), never by its files.
 *
 * - **An app:** a runtime with the memory store, chat and the fake model,
 *   sends a message and reads the reply; again on PostgreSQL, in a schema of
 *   its own that it drops after, when `COPILOTZ_TEST_POSTGRES_URL` is set.
 * - **Every entry point** loads on Node, and the app and all of them
 *   type-check against the package's declarations (`skipLibCheck: false`).
 * - **The browser's code** bundles from the installed package
 *   (`copilotz/web/node`'s `bundle`), split as on Deno.
 *
 *   npm run build && node scripts/npm/smoke.ts [--ominipg=path/to/ominipg-x.y.z.tgz]
 *
 * `--ominipg` installs Ominipg from a tarball, before it's on npm.
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
const manifest = JSON.parse(readFileSync(join(DIST, "package.json"), "utf8")) as {
  name: string;
  version: string;
  exports: Record<string, unknown>;
};
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
import { chatWeb, memoryWeb, teamWeb } from "copilotz/plugins/agents/web";
import { spacesWeb } from "copilotz/plugins/access/web";
import { computersWeb } from "copilotz/plugins/compute/web";

await web({
  root: document.getElementById("app")!,
  plugins: [webShell, chatWeb, spacesWeb, teamWeb, memoryWeb, computersWeb],
});
`;

const BUNDLE = `import { bundle } from "copilotz/web/node";

const code = await bundle(new URL("./browser.tsx", import.meta.url));
const sizes = Object.entries(code.files).map(([name, text]) => \`\${name} \${Math.round(text.length / 1024)} KB\`);
if (Object.keys(code.files).length < 2) throw new Error("the browser's code wasn't split");
console.log(\`  \${code.entry}: \${sizes.join(", ")}\`);
`;

/** Every entry point, by its name, loaded: each must load on Node, and type-check. */
const names = Object.keys(manifest.exports).filter((name) => name !== "./package.json")
  .map((name) => manifest.name + name.slice(1));
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

const dir = mkdtempSync(join(tmpdir(), "copilotz-npm-"));
try {
  step(`packing ${manifest.name}@${manifest.version}`);
  run("npm", ["pack", DIST, "--pack-destination", dir, "--silent"], ROOT);
  const tarball = readdirSync(dir).find((name) => name.endsWith(".tgz"))!;
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "copilotz-npm-smoke",
        private: true,
        type: "module",
        dependencies: { [manifest.name]: `file:./${tarball}` },
        devDependencies: dev,
        ...(ominipg ? { overrides: { ominipg: `file:${resolve(ominipg)}` } } : {}),
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "app.ts"), APP);
  writeFileSync(join(dir, "browser.tsx"), BROWSER);
  writeFileSync(join(dir, "bundle.ts"), BUNDLE);
  writeFileSync(join(dir, "surface.ts"), SURFACE);
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(TSCONFIG, null, 2));

  step("installing it into a new project");
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], dir);
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
