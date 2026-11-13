/**
 * The copilotz skill (skills/copilotz), the Agent Skill a coding agent loads
 * to build an app with Copilotz, and the plugin manifests that carry it to
 * Claude Code, Codex, Cursor, Copilot and Gemini CLI: what they name is
 * there, as testing/agents-md.test.ts holds AGENTS.md to it. Its frontmatter
 * is the Agent Skills spec's; each `copilotz…` it imports from or names is an
 * entry point, and each value it imports, or says comes from one, is exported
 * there; each docs page it links is in docs/manifest.json; each file it links
 * is inside the skill, which installs on its own; it names no version, since
 * scripts/version.ts doesn't move it; the commands it gives are the scripts
 * it sets up; and the manifests agree on the plugin, its version (Copilotz's)
 * and the docs' MCP server.
 */
import { assertEquals, assertNotEquals } from "@std/assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "./mod.ts";

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const SKILL = join(ROOT, "skills", "copilotz");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const json = (path: string) => JSON.parse(read(path));

/** SKILL.md and its references, by path from the repository's root. */
const files = [
  "skills/copilotz/SKILL.md",
  ...readdirSync(join(SKILL, "references")).filter((name) => name.endsWith(".md"))
    .map((name) => `skills/copilotz/references/${name}`),
];
const texts = files.map((path) => ({ path, text: read(path) }));
const all = texts.map(({ text }) => text).join("\n");

const deno = json("deno.json") as { version: string; exports: Record<string, string> };
/** The file of an entry point, `copilotz` or `copilotz/<path>`; undefined for none. */
const entry = (spec: string): string | undefined =>
  deno.exports[`.${spec.slice("copilotz".length)}`];
const exported = async (spec: string, names: string[]): Promise<string[]> => {
  const file = entry(spec);
  if (!file) return [`${spec}: not an entry point`];
  // Types are the type checker's; Node runs no .tsx.
  if (!names.length || file.endsWith(".tsx")) return [];
  const module = await import(pathToFileURL(join(ROOT, file)).href);
  return names.filter((name) => !(name in module)).map((name) => `${spec}: no ${name}`);
};

/** The docs' MCP server: planned at copilotz.com, over streamable HTTP. */
const DOCS_MCP = "https://copilotz.com/api/mcp";

test("the copilotz skill's frontmatter is the Agent Skills spec's", () => {
  const skill = read("skills/copilotz/SKILL.md");
  const [, head] = /^---\n([\s\S]*?)\n---\n/.exec(skill) ?? [];
  assertNotEquals(head, undefined, "SKILL.md starts with frontmatter");
  const top: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const [, indent, name, value] = /^( *)([\w-]+):(?: (.*))?$/.exec(line) ?? [];
    if (!name) throw new Error(`frontmatter: not a key: ${line}`);
    if (indent) metadata[name] = value;
    else top[name] = value ?? "";
  }
  const wrong: string[] = [];
  const allowed = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
  for (const name of Object.keys(top)) if (!allowed.includes(name)) wrong.push(`no key ${name}`);
  // A plain scalar each: no ": " or " #" inside, nothing YAML reads as structure up front.
  for (const [name, value] of Object.entries({ ...top, ...metadata })) {
    if (name !== "metadata" && (/: | #|^[[{&*!|>'"%@`-]/.test(value) || !value)) {
      wrong.push(`${name}: not a plain scalar`);
    }
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(top.name) || top.name.length > 64) wrong.push("name");
  if (top.name !== "copilotz") wrong.push("name: not its folder's");
  if (top.description.length > 1024) wrong.push(`description: ${top.description.length} chars`);
  if ("metadata" in top && !Object.keys(metadata).length) wrong.push("metadata: empty");
  // Short, with the details in references (the spec: under 500 lines).
  if (skill.split("\n").length > 250) wrong.push("SKILL.md: over 250 lines");
  assertEquals(wrong, []);
});

test("the copilotz skill imports what Copilotz's entry points export", async () => {
  const wrong: string[] = [];
  const imports = all.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"(copilotz[^"]*)"/g);
  let seen = 0;
  for (const [, typeOnly, names, spec] of imports) {
    seen++;
    const values = typeOnly ? [] : names.split(",").map((name) => name.trim())
      .filter((name) => name && !name.startsWith("type "));
    wrong.push(...await exported(spec, values));
  }
  assertNotEquals(seen, 0);
  for (const [, spec] of all.matchAll(/`(copilotz(?:\/[a-z/]+)?)`/g)) {
    if (!entry(spec)) wrong.push(`${spec}: not an entry point`);
  }
  // In words: "`serve(handler)`, from `copilotz/testing`".
  for (const [, name, spec] of all.matchAll(/`(\w+)(?:\([^`]*\))?`,? from `(copilotz[\w/]*)`/g)) {
    wrong.push(...await exported(spec, [name]));
  }
  // The helpers `allow` takes, in the rules' table.
  const helpers = [...read("skills/copilotz/references/rules.md").matchAll(/^\| `(\w+)` +\|/gm)]
    .map(([, name]) => name);
  assertNotEquals(helpers.length, 0);
  wrong.push(...await exported("copilotz", helpers));
  assertEquals(wrong, []);
});

test("the copilotz skill links docs pages that exist, and files inside it", () => {
  type Manifest = { sections: { items: { slug: string }[] }[] };
  const manifest = json("docs/manifest.json") as Manifest;
  const slugs = new Set(manifest.sections.flatMap((section) => section.items.map((i) => i.slug)));
  const linked = [...all.matchAll(/https:\/\/copilotz\.com\/docs\/([^\s)`]+?)\.md/g)]
    .map(([, slug]) => slug).filter((slug) => !slug.includes("<"));
  assertNotEquals(linked.length, 0);
  assertEquals(linked.filter((slug) => !slugs.has(slug)), [], "not in docs/manifest.json");
  const wrong: string[] = [];
  for (const { path, text } of texts) {
    for (const [, link] of text.matchAll(/\]\((?!https?:)([^)#]+)(?:#[^)]*)?\)/g)) {
      const target = normalize(join(ROOT, dirname(path), link));
      // `npx skills add` copies the skill's folder alone: links stay inside it.
      if (relative(SKILL, target).startsWith("..")) wrong.push(`${path}: ${link} leaves the skill`);
      else if (!existsSync(target)) wrong.push(`${path}: ${link} isn't there`);
    }
  }
  const repo = /https:\/\/github\.com\/copilotzhq\/copilotz\/blob\/main\/([^\s)`]+)/g;
  for (const [, file] of all.matchAll(repo)) if (!existsSync(join(ROOT, file))) wrong.push(file);
  assertEquals(wrong, []);
});

test("the copilotz skill names no version, and gives the commands it sets up", () => {
  // scripts/version.ts doesn't move the skill: it installs `copilotz@next`, the release candidates.
  assertEquals([...all.matchAll(/copilotz@\^?\d[\w.-]*/g)].map(([v]) => v), []);
  const walkthrough = read("skills/copilotz/references/plugin-walkthrough.md");
  const [, block] = /```json\n("scripts": \{[\s\S]*?\})\n```/.exec(walkthrough) ?? [];
  assertNotEquals(block, undefined, "the walkthrough gives the app's scripts");
  const scripts = JSON.parse(`{${block}}`).scripts as Record<string, string>;
  const wrong = [
    ...[...all.matchAll(/npm run (\w+)/g)].filter(([, name]) => !scripts[name]),
    ...[...all.matchAll(/npm test\b/g)].filter(() => !scripts.test),
  ].map(([match]) => match);
  assertEquals(wrong, []);
  // It sends agents to the guide in the package: the npm build copies it there.
  assertNotEquals(all.indexOf("node_modules/copilotz/AGENTS.md"), -1);
  assertNotEquals(read("scripts/npm/build.ts").indexOf(`"AGENTS.md"`), -1);
});

test("the plugin manifests agree: the copilotz plugin, Copilotz's version, the docs' MCP", () => {
  const claude = json(".claude-plugin/plugin.json");
  const market = json(".claude-plugin/marketplace.json");
  const portable = json("plugin.json"); // Agent Plugins: Codex, Cursor, Copilot
  const mcp = json("mcp.json");
  const gemini = json("gemini-extension.json");
  const said = {
    names: [claude.name, market.plugins[0].name, portable.name, gemini.name],
    versions: [claude.version, portable.version, gemini.version],
    source: market.plugins.map((plugin: { source: string }) => plugin.source),
    schemas: [portable.$schema, mcp.$schema],
    servers: [
      claude.mcpServers["copilotz-docs"],
      mcp.mcpServers["copilotz-docs"],
      gemini.mcpServers["copilotz-docs"],
    ],
  };
  assertEquals(said, {
    names: ["copilotz", "copilotz", "copilotz", "copilotz"],
    // scripts/version.ts doesn't list these yet: a release moves them by hand.
    versions: [deno.version, deno.version, deno.version],
    source: ["./"],
    schemas: [
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    ],
    // Streamable HTTP, as each host spells it.
    servers: [
      { type: "http", url: DOCS_MCP },
      { type: "streamable-http", url: DOCS_MCP },
      { httpUrl: DOCS_MCP },
    ],
  });
  // Each host finds the skill in skills/ by itself; the skill names the same server.
  assertEquals(existsSync(join(SKILL, "SKILL.md")), true);
  assertNotEquals(read("skills/copilotz/SKILL.md").indexOf(DOCS_MCP), -1);
});
