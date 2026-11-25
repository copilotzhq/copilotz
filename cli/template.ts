const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** The files of a new app, pinned to the version of Copilotz that made it. */
export function template(version: string): Record<string, string> {
  return {
    "package.json": json({
      name: "orders-app",
      private: true,
      type: "module",
      imports: { "#copilotz/*": "./.copilotz/build/*" },
      scripts: {
        dev: "copilotz gen && node dev.ts",
        start: "copilotz gen && node --import ./tsx.ts server.ts",
        build: "copilotz gen && tsc --noEmit",
        test: 'node --import ./tsx.ts --test "tests/*.test.ts"',
        check: "copilotz gen --check && tsc --noEmit && eslint . && prettier --check . && npm test",
      },
      dependencies: { copilotz: version, react: "^19.3.1", "react-dom": "^19.3.1" },
      devDependencies: {
        "@types/node": "^24.0.0",
        "@types/react": "^19.3.0",
        "@types/react-dom": "^19.3.0",
        esbuild: "^0.28.2",
        eslint: "^9.0.0",
        prettier: "^3.0.0",
        typescript: "~6.0.3",
        "typescript-eslint": "^8.0.0",
      },
    }),
    "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true,
    "types": ["node", "react"]
  },
  "include": ["**/*.ts", "**/*.tsx", ".copilotz/build/**/*.ts"]
}
`,
    "eslint.config.js": `import tseslint from "typescript-eslint";

export default [
  { ignores: [".copilotz/**", "copilotz-env.d.ts"] },
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] } },
];
`,
    ".prettierrc.json": json({ printWidth: 100 }),
    ".prettierignore": ".copilotz/\ncopilotz-env.d.ts\npackage-lock.json\n",
    ".gitignore": "node_modules/\n.copilotz/build/\n.env\n",
    "app.ts": `import { identity } from "copilotz/plugins/access/identity";
import { devSignIn } from "copilotz/plugins/access/dev";
import orders from "#copilotz/plugins/orders/mod.ts";

export function plugins() {
  return [identity, devSignIn, orders];
}
`,
    "plugins/orders/collections/order.ts": `import { defineCollection, people } from "copilotz";

export default defineCollection({
  schema: {
    type: "object",
    properties: { shipped: { type: "boolean" } },
    required: ["shipped"],
    additionalProperties: false,
  },
  queries: {
    pending: { allow: people, run: (orders) => orders.countDocuments({ shipped: false }) },
  },
});
`,
    "plugins/orders/actions/order.ship.ts":
      `import { defineAction, failure, people } from "copilotz";

export default defineAction({
  description: "Ship a pending order",
  allow: people,
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  run: async (ctx, { id }) => {
    const orders = ctx.db.collection("order");
    const result = await orders.updateOne({ _id: id, shipped: false }, { $set: { shipped: true } });
    if (!result.matchedCount) throw failure("invalid", "No pending order here.", { public: true });
    return { shipped: id };
  },
});
`,
    "plugins/orders/views/web/web.shell.tsx": `import type { ViewContext } from "copilotz";
import { Page, Text } from "copilotz/web";

export default function orders(_: unknown, ctx: ViewContext) {
  const pending = ctx.db.collection("order").query<number>("pending");
  return (
    <Page title="Orders">
      <Text>{pending.status === "ready" ? \`Pending orders: \${pending.value}\` : "Loading…"}</Text>
    </Page>
  );
}
`,
    "front.ts": `import orders from "#copilotz/plugins/orders/web.ts";

export const plugins = [orders];
`,
    "browser.tsx": `import { web } from "copilotz/web";
import { plugins } from "./front.ts";

await web({ root: document.getElementById("app")!, plugins });
`,
    "server.ts": `import { createRuntime, definePlugin } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { bundle, listen } from "copilotz/web/node";
import { webPage } from "copilotz/web/server";
import { plugins } from "./app.ts";

const page = definePlugin({
  name: "page",
  resources: {
    page: { title: "Orders", code: () => bundle(new URL("./browser.tsx", import.meta.url)) },
  },
});
const runtime = await createRuntime({
  store: memoryStore(),
  plugins: [...plugins(), webPage, page],
});
const server = await listen(runtime.fetch, { port: 8080 });
console.log(server.url);
`,
    "tsx.ts": `import { register } from "node:module";

register("./tsx-hooks.ts", import.meta.url);
`,
    "tsx-hooks.ts": `import { readFile } from "node:fs/promises";
import type { LoadHook } from "node:module";
import { transform } from "esbuild";

export const load: LoadHook = async (url, context, next) => {
  if (!url.startsWith("file:") || !url.endsWith(".tsx")) return next(url, context);
  const source = await readFile(new URL(url), "utf8");
  const { code } = await transform(source, { loader: "tsx", jsx: "automatic", format: "esm" });
  return { format: "module", source: code, shortCircuit: true };
};
`,
    "dev.ts": `import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const children = [
  spawn(process.execPath, [fileURLToPath(import.meta.resolve("copilotz/gen")), "gen", "--watch"], {
    stdio: "inherit",
  }),
  spawn(
    process.execPath,
    ["--import", "./tsx.ts", "--import", "./front.ts", "--watch", "server.ts"],
    {
      stdio: "inherit",
    },
  ),
];
function stop() {
  for (const child of children) child.kill();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
for (const child of children) {
  child.once("exit", (code) => {
    if (code) process.exitCode = code;
    stop();
  });
}
`,
    "tests/orders.test.ts": `import assert from "node:assert/strict";
import { test } from "node:test";
import { describe } from "copilotz/describe";
import orders from "#copilotz/plugins/orders/mod.ts";

test("orders describes itself without problems", async () => {
  assert.deepEqual((await describe(orders)).listing.problems, []);
});
`,
  };
}
