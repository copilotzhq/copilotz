/**
 * The describe CLI's parts: the reference page a declaration makes, and what
 * a plugin's code shows (the resource kinds it reads, its settings, its
 * first sentence). Reading code runs `deno info` and `deno doc`, so those
 * tests, and the CLI's, run on Deno only.
 */
import { assert, assertEquals, assertFalse, assertMatch } from "@std/assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { definePlugin, inPerson, people, peopleOrContacts } from "../../runtime/mod.ts";
import { describe } from "../../runtime/describe.ts";
import { page } from "../describe/markdown.ts";
import {
  firstSentence,
  found,
  readsIn,
  summaryIn,
  uncommented,
  usedIn,
} from "../describe/sources.ts";
import { runtime, test } from "../../testing/mod.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const run = () => {
  throw new Error("never run");
};

const notes = definePlugin({
  name: "notes",
  requires: ["chat", "spaces"],
  collections: {
    note: {
      schema: { type: "object", properties: { in: { type: "string" }, text: { type: "string" } } },
    },
  },
  actions: {
    "note.add": {
      description: "Adds a note. It's Markdown.",
      input: { type: "object" },
      allow: people,
      run,
    },
    "note.read": {
      description: "Reads a note",
      input: { type: "object" },
      allow: peopleOrContacts,
      run,
    },
    "note.purge": {
      description: "Purges your notes.",
      input: { type: "object" },
      allow: inPerson,
      run,
    },
    "note.sweep": { run },
  },
  views: { "web.note": () => null, "llm.note": () => null },
  resources: {
    shared: { note: {} },
    tools: {
      add_note: {
        description: "Add a note.",
        run: (_: unknown, ctx: { call(a: string): unknown }) => ctx.call("note.add"),
      },
    },
  },
  routes: { "/notes/:id": () => new Response("ok") },
  schedules: { "notes.sweep": { cron: "0 3 * * *", call: "note.sweep", input: {} } },
});

test("page: the five sections, in order, in the docs' voice", async () => {
  const d = await describe(notes, {
    summary: "Notes: what people jot down, in a space.",
    package: { name: "@copilotz/notes" },
    runtime: "^1.0.0",
    layer: "package",
    settings: [{
      kind: "notes",
      type: "NotesSettings",
      inContract: true,
      fields: [{
        name: "key",
        type: "string",
        optional: false,
        doc: "What signs a note.",
        secret: true,
      }],
    }],
  });
  const text = page(d, {
    module: "@copilotz/notes",
    export: "notes",
    frontEnds: ["notes-web"],
    pages: new Set(["chat", "notes-web"]),
  });
  const headings = [...text.matchAll(/^## (.+)$/gm)].map(([, h]) => h);
  assertEquals(headings, [
    "What it keeps",
    "What it lets callers do",
    "Where it shows",
    "What it needs",
    "What it requires",
    "What it does on its own",
    "Listing",
  ]);
  assert(
    text.startsWith(
      '---\ntitle: "notes"\ndescription: "Notes: what people jot down, in a space."\n---\n',
    ),
  );
  assert(text.includes('import { notes } from "@copilotz/notes";'));
  assert(text.includes("The access rules cover `note`"));
  assert(
    text.includes(
      "Of its 4 Actions, people may call 3; agents may call 2; contacts may call 1; someone signed out may call none.",
    ),
  );
  // A row per Action open to callers, its first sentence ending as one does.
  // A routine's column, since `inPerson` keeps it out where `people` lets it in.
  assert(
    text.includes("| Action | Person | Agent | Contact | Anyone | Key | Routine | What it does |"),
  );
  assertMatch(text, /\| `note\.add` \| yes \| yes \| no \| no \| yes \| yes \| Adds a note\. \|/);
  assertMatch(
    text,
    /\| `note\.purge` \| yes \| no \| no \| no \| no \| no \| Purges your notes\. \|/,
  );
  assert(text.includes("A routine is work done for a person, which they set going."));
  assert(text.includes("| Reads a note. |") || /Reads a note\. +\|/.test(text));
  assert(text.includes("Only the app's own code calls `note.sweep`"));
  assertMatch(text, /\| `add_note` \| Add a note\. +\| `note\.add` \|/);
  assert(text.includes("- **On the web:** `web.note`."));
  assert(text.includes("- **To the model:** `llm.note`."));
  assert(text.includes("- **Front ends:** [`notes-web`](notes-web.md)."));
  assert(text.includes("| `notes.key` | `string` | yes | Secret. What signs a note. |"));
  assert(
    text.includes(
      "The runtime doesn't start without [`chat`](chat.md) and `spaces`: add them too.",
    ),
  );
  assert(text.includes("It moves to its own package, `@copilotz/notes`, for `copilotz` `^1.0.0`."));
  assert(text.includes("- `notes.sweep` calls `note.sweep`, cron 0 3 * * * (UTC)."));
  assert(text.includes("It keeps every listing rule."));
  assertFalse(/\n\n\n/.test(text));
});

test("page: a plugin with nothing says so plainly", async () => {
  const text = page(await describe(definePlugin({ name: "empty" })));
  assert(text.includes("It keeps nothing of its own."));
  assert(text.includes("Nobody calls it: it has no Actions, tools or routes."));
  assert(text.includes("It has no Views: it shows nowhere on its own."));
  assert(text.includes("Nothing to set: it works as it comes."));
  assert(text.includes("It builds on no other plugin."));
});

test("sources: reads, comments, sentences, summaries", () => {
  assertEquals(
    readsIn(`
      // resources.commented
      /* resources.blocked */
      const a = ctx.resources.google as GoogleSettings;
      const b = merged.resources?.links;
      const c = resources["shared"];
    `),
    ["google", "links", "shared"],
  );
  assertEquals(uncommented("a // b\nc /* d */ e"), "a \nc  e");
  assertEquals(
    firstSentence("Boards: kanban boards. More here.\n\nAnd more."),
    "Boards: kanban boards.",
  );
  assertEquals(
    firstSentence("Boards' web front end, for the browser:"),
    "Boards' web front end, for the browser.",
  );
  assertEquals(
    summaryIn(
      "/** The file. */\nimport x from 'y';\n/** The plugin, at last. */\nexport const p = 1;",
      "p",
    ),
    "The plugin, at last.",
  );
  assertEquals(summaryIn("/** The file's. Second. */\nexport const p = 1;", "q"), "The file's.");
});

test("sources: a declaration uses what it names, file by file, never the rest", () => {
  const file = "/app/plugins/mail/mod.ts";
  const source = [
    'import { send } from "./actions/send.ts";',
    'import { signIn as enter } from "./actions/sign-in.ts";',
    'import { definePlugin } from "../../runtime/mod.ts";',
    'export * from "./contract.ts";',
    "",
    "const origin = (resources: Record<string, unknown>) => resources.links;",
    "",
    "export const mail = definePlugin({",
    '  name: "mail",',
    '  actions: { "mail.send": send },',
    "  check(merged) {",
    "    origin(merged.resources);",
    "  },",
    "});",
    "",
    "export const mailSignIn = definePlugin({",
    '  name: "mail-sign-in",',
    '  requires: ["mail"],',
    '  actions: { "mail.signIn": enter },',
    "});",
  ].join("\n");
  const names = (wants: { file: string; name: string }[]) =>
    wants.map((w) => `${w.file.replace("/app/", "")}#${w.name}`).sort();
  // Each plugin of the file: its own declaration, and the local ones it names.
  const mail = usedIn(source, file, { plugin: "mail" });
  assertEquals(names(mail.wants), [
    "plugins/mail/actions/send.ts#send",
    "runtime/mod.ts#definePlugin",
  ]);
  assertEquals([readsIn(mail.text), mail.whole], [["links"], false]);
  // A name in a string (`requires: ["mail"]`) isn't a use of the declaration `mail`.
  const signIn = usedIn(source, file, { plugin: "mail-sign-in" });
  assertEquals(names(signIn.wants), [
    "plugins/mail/actions/sign-in.ts#signIn",
    "runtime/mod.ts#definePlugin",
  ]);
  assertEquals(readsIn(signIn.text), []);
  // A name it re-exports is followed to its file; one it doesn't have, the whole file.
  assertEquals(names(usedIn(source, file, { names: ["Mail"] }).wants), [
    "plugins/mail/contract.ts#Mail",
  ]);
  assert(usedIn("const a = 1;", file, { names: ["b"] }).whole);
  assert(usedIn(source, file, { plugin: "other" }).whole);
});

test({
  name: "sources: Copilotz's own plugins, as their code shows them",
  ignore: runtime !== "deno",
  fn: async () => {
    const access = join(ROOT, "plugins/access/mod.ts");
    const google = await found(access, "googleSignIn", "google-sign-in");
    assert(google.home.endsWith("plugins/access/google/mod.ts"));
    assertEquals(google.reads, ["google"]);
    assertEquals(google.settings.map((s) => [s.kind, s.type, s.inContract]), [[
      "google",
      "GoogleSettings",
      true,
    ]]);
    assertEquals(google.settings[0].fields.map((f) => [f.name, f.optional]), [["clientId", false]]);
    assertMatch(google.summary!, /^Google sign-in: /);

    // Two plugins in one file: the email port reads what its own declaration does.
    const email = await found(access, "email", "email");
    const signIn = await found(access, "emailSignIn", "email-sign-in");
    assert(email.files.length < signIn.files.length);
    assert(email.reads.includes("email"));
    assert(signIn.reads.includes("emailSignIn"));

    // A map of entries: each WhatsApp number's settings, its token a secret.
    const whatsapp = await found(join(ROOT, "plugins/interfaces/mod.ts"), "whatsapp", "whatsapp");
    const numbers = whatsapp.settings.find((s) => s.kind === "whatsapp")!;
    assert(numbers.each);
    assert(numbers.fields.some((f) => f.name === "token" && f.secret));
  },
});

test({
  name: "the CLI: a module's plugin as JSON, and as a page",
  ignore: runtime !== "deno",
  fn: async () => {
    // deno-lint-ignore no-explicit-any
    const Deno = (globalThis as any).Deno;
    const cli = (...args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", join(ROOT, "scripts/describe.ts"), ...args],
        cwd: ROOT,
        stdout: "piped",
        stderr: "piped",
      }).output();
    const json = await cli("plugins/work/mod.ts", "boards");
    assert(json.success, new TextDecoder().decode(json.stderr));
    const d = JSON.parse(new TextDecoder().decode(json.stdout));
    assertEquals([d.name, d.package?.name, d.runtime !== undefined], ["boards", "copilotz", true]);
    const markdown = await cli("plugins/work/mod.ts", "boards", "--markdown");
    assert(new TextDecoder().decode(markdown.stdout).includes("## What it keeps"));
    const wrong = await cli("plugins/agents/mod.ts", "openapi");
    assertFalse(wrong.success);
    assertMatch(new TextDecoder().decode(wrong.stderr), /makes a plugin/);
  },
});
