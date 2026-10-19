import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
const root = new URL("../", import.meta.url);
test("new project contains all six primitive directories and separate Node/browser entries", async () => {
  for (
    const name of [
      "actions",
      "adapters",
      "collections",
      "processors",
      "views",
      "resources",
    ]
  ) assert.ok((await stat(new URL(name, root))).isDirectory());
  const owner = await readFile(new URL("owner.ts", root), "utf8");
  assert.match(owner, /role: "gateway"/);
  assert.doesNotMatch(owner, /role: "embedded"/);
  const worker = await readFile(new URL("worker.ts", root), "utf8");
  assert.match(worker, /@copilotz\/copilotz\/worker/);
  assert.match(worker, /role: "worker"/);
  assert.doesNotMatch(worker, /database:\s*\{/);
  const app = await readFile(new URL("page.ts", root), "utf8");
  assert.match(app, /collections\.observe/);
  assert.doesNotMatch(app, /setInterval|innerHTML|createElement/);
});
