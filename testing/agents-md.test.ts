/**
 * AGENTS.md, the guide an app's coding agent reads (it ships in the npm and
 * JSR packages): what it names is there. Each `copilotz…` it imports from or
 * names is an entry point, and each value it imports is exported there; each
 * product package it names is one; each docs page it links is in
 * docs/manifest.json (the site answers any other path with its home page, so
 * a wrong slug wouldn't 404); each file it links is in the repository; it
 * installs this version; and the checks its last section gives are the
 * repository's.
 */
import { assertEquals, assertNotEquals } from "@std/assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "./mod.ts";

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const guide = read("AGENTS.md");
const deno = JSON.parse(read("deno.json")) as {
  version: string;
  exports: Record<string, string>;
  tasks: Record<string, string>;
};
const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
/** The file of an entry point, `copilotz` or `copilotz/<path>`; undefined for none. */
const entry = (spec: string): string | undefined =>
  deno.exports[`.${spec.slice("copilotz".length)}`];

test("AGENTS.md imports what Copilotz's entry points export", async () => {
  const wrong: string[] = [];
  const imports = guide.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"(copilotz[^"]*)"/g);
  for (const [, typeOnly, names, spec] of imports) {
    const file = entry(spec);
    if (!file) {
      wrong.push(`${spec}: not an entry point`);
      continue;
    }
    // Types are the type checker's; Node runs no .tsx.
    const values = typeOnly ? [] : names.split(",").map((name) => name.trim())
      .filter((name) => name && !name.startsWith("type "));
    if (!values.length || file.endsWith(".tsx")) continue;
    const module = await import(pathToFileURL(join(ROOT, file)).href);
    for (const name of values) if (!(name in module)) wrong.push(`${spec}: no ${name}`);
  }
  for (const [, spec] of guide.matchAll(/`(copilotz(?:\/[a-z/]+)?)`/g)) {
    if (!entry(spec)) wrong.push(`${spec}: not an entry point`);
  }
  for (const [, name] of guide.matchAll(/`@copilotz\/([a-z]+)`/g)) {
    // `@copilotz/copilotz` is Copilotz itself, on JSR; the others, packages/<name>.
    const own = name === "copilotz"
      ? join(ROOT, "deno.json")
      : join(ROOT, "packages", name, "deno.json");
    const said = existsSync(own) ? JSON.parse(readFileSync(own, "utf8")).name : undefined;
    if (said !== `@copilotz/${name}`) wrong.push(`@copilotz/${name}: not a product package`);
  }
  assertEquals(wrong, []);
});

test("AGENTS.md links docs pages that exist, and files in the repository", () => {
  type Manifest = { sections: { items: { slug: string }[] }[] };
  const manifest = JSON.parse(read("docs/manifest.json")) as Manifest;
  const slugs = new Set(manifest.sections.flatMap((section) => section.items.map((i) => i.slug)));
  const linked = [...guide.matchAll(/https:\/\/copilotz\.com\/docs\/([^\s)`]+?)\.md/g)]
    .map(([, slug]) => slug).filter((slug) => !slug.includes("<"));
  assertNotEquals(linked.length, 0);
  assertEquals(linked.filter((slug) => !slugs.has(slug)), [], "not in docs/manifest.json");
  const files = [...guide.matchAll(/\]\((?!https?:)([^)]+)\)/g)].map(([, path]) => path);
  assertEquals(files.filter((path) => !existsSync(join(ROOT, path))), []);
});

test("AGENTS.md installs this version", () => {
  const said = [...guide.matchAll(/copilotz@\^?(\d+\.\d+\.\d+(?:-[\w.]*\w)?)/g)].map(([, v]) => v);
  assertNotEquals(said.length, 0);
  assertEquals(said.filter((v) => v !== deno.version), [], `deno.json says ${deno.version}`);
});

test("AGENTS.md's checks for Copilotz itself are the repository's", () => {
  const own = guide.slice(guide.indexOf("## Working on Copilotz itself"));
  const wrong = [
    ...[...own.matchAll(/deno task (\w+)/g)].filter(([, task]) => !deno.tasks[task]),
    ...[...own.matchAll(/npm run (\w+)/g)].filter(([, script]) => !scripts[script]),
    ...[...own.matchAll(/npm test/g)].filter(() => !scripts.test),
    ...[...own.matchAll(/(?<=[\s`])((?:[\w-]+\/)+[\w.-]+\.(?:ts|py|md))/g)]
      .filter(([, path]) => !existsSync(join(ROOT, path))),
  ].map(([match]) => match);
  assertEquals(wrong, []);
});
