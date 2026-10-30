/**
 * Skills on the web, their logic: SKILL.md read and written back (plain,
 * quoted and block values, without a front matter), what a name becomes
 * as it's typed, what's wrong with a skill as the Actions would say it,
 * what picked files make (a folder's top taken off, hidden, binary and
 * unplain files left out and said), what a search finds, a skill's page,
 * and what changed between a skill and its form.
 */
import { assertEquals } from "@std/assert";
import { nameOf, problems } from "../skills/shared/check.ts";
import { formatSkillMd, parseSkillMd } from "../skills/shared/skill-md.ts";
import type { Shown } from "../skills/shared/skills.ts";
import {
  changes,
  freePath,
  fromPicked,
  markdownish,
  matches,
  merged,
  skillPath,
} from "../skills/views/web/skills.ts";
import { test } from "../../../testing/mod.ts";

test("a SKILL.md, read: its name, purpose and instructions; and written back", () => {
  const md = [
    "---",
    "name: weekly-report",
    'description: "Write the weekly report: shipped, next, blocked."',
    "license: MIT",
    "---",
    "",
    "# Weekly report",
    "",
    "Three sections.",
  ].join("\n");
  const read = parseSkillMd(md);
  assertEquals(read, {
    name: "weekly-report",
    description: "Write the weekly report: shipped, next, blocked.",
    instructions: "# Weekly report\n\nThree sections.",
  });
  assertEquals(parseSkillMd(formatSkillMd(read as Required<typeof read>)), read);
  // Folded and literal blocks, single quotes, Windows line ends, a byte order mark.
  assertEquals(
    parseSkillMd(
      "﻿---\r\nname: 'it''s-fine'\r\ndescription: >\r\n  Folded over\r\n  two lines.\r\n---\r\nBody",
    ),
    { name: "it's-fine", description: "Folded over two lines.", instructions: "Body" },
  );
  assertEquals(
    parseSkillMd("---\ndescription: |\n  Kept\n  as is\nname: x\n---\n").description,
    "Kept\nas is",
  );
  // Without a front matter, it's all instructions.
  assertEquals(parseSkillMd("# Just steps\n\n1. Do it."), {
    instructions: "# Just steps\n\n1. Do it.",
  });
  // Written plainly when it can be, quoted when it must.
  assertEquals(
    formatSkillMd({ name: "a", description: "Plain words", instructions: "Do.\n" }),
    "---\nname: a\ndescription: Plain words\n---\n\nDo.\n",
  );
  assertEquals(
    formatSkillMd({ name: "a", description: "Has: a colon", instructions: "Do." }).split("\n")[2],
    'description: "Has: a colon"',
  );
});

test("names as agents call skills, and what's wrong with one", () => {
  assertEquals(nameOf("Weekly Report!"), "weekly-report");
  assertEquals(nameOf("  Relatório  de  Vendas "), "relatorio-de-vendas");
  assertEquals(nameOf("x".repeat(80)).length, 64);
  assertEquals(problems({ name: "ok-name", description: "Fine.", instructions: "Do." }), {});
  assertEquals(Object.keys(problems({ name: "Bad Name", description: " ", instructions: "" })), [
    "name",
    "description",
    "instructions",
  ]);
  const files = (paths: string[]) => paths.map((path) => ({ path, text: "x" }));
  assertEquals(
    Object.keys(problems({ files: files(["a.md", "../b.md", "SKILL.md", "a.md", "/c", "d/./e"]) })),
    ["files.1", "files.2", "files.3", "files.4", "files.5"],
  );
});

test("what picked files make: a SKILL.md's fields, and the rest as its files", () => {
  const folder = fromPicked([
    { path: "weekly/SKILL.md", text: "---\nname: weekly\ndescription: Weekly.\n---\nSteps." },
    { path: "weekly/templates/plan.md", text: "## Plan" },
    { path: "weekly/.DS_Store", text: "", binary: true },
    { path: "weekly/logo.png", text: "\u0000PNG", binary: true },
    { path: "weekly/a b.md", text: "spaces are fine" },
  ]);
  assertEquals(folder.md, { name: "weekly", description: "Weekly.", instructions: "Steps." });
  assertEquals(folder.files.map((f) => f.path), ["a b.md", "templates/plan.md"]);
  assertEquals(folder.skipped, ["logo.png (not text)"]);
  // Files on their own: no top folder to take off.
  const loose = fromPicked([
    { path: "SKILL.md", text: "Only steps." },
    { path: "notes.txt", text: "n" },
  ]);
  assertEquals([loose.md?.instructions, loose.files.map((f) => f.path)], ["Only steps.", [
    "notes.txt",
  ]]);
  assertEquals(fromPicked([{ path: "x.md", text: "y".repeat(500_001) }]).skipped, [
    "x.md (too long)",
  ]);
  // Added to what's there: the same path replaced, the rest kept, in order.
  assertEquals(
    merged([{ path: "b.md", text: "old" }, { path: "a.md", text: "a" }], [{
      path: "b.md",
      text: "new",
    }]),
    [{ path: "a.md", text: "a" }, { path: "b.md", text: "new" }],
  );
  assertEquals(
    freePath([{ path: "notes.md", text: "" }, { path: "notes-2.md", text: "" }]),
    "notes-3.md",
  );
});

test("finding a skill, its page, and what changed in its form", () => {
  const skill: Shown = {
    _id: "s1",
    name: "weekly-report",
    description: "Write the Weekly report",
    source: "space",
    size: 10,
    files: [{ path: "templates/plan.md", size: 5 }],
  };
  assertEquals([matches(skill, "WEEKLY"), matches(skill, "plan"), matches(skill, "monthly")], [
    true,
    true,
    false,
  ]);
  assertEquals(skillPath("app:planning", "s 1"), "/skill/app%3Aplanning?in=s%201");
  assertEquals(skillPath("s1", undefined, true), "/skill/s1?edit=1");
  assertEquals([markdownish("a.MD"), markdownish("run.sh")], [true, false]);
  const was = { name: "a", description: "D", instructions: "I", files: [{ path: "f", text: "t" }] };
  assertEquals(changes(was, { ...was }), {});
  assertEquals(changes(was, { ...was, name: " b ", files: [] }), { name: "b", files: [] });
  assertEquals(changes(was, { ...was, files: [{ path: "f", text: "u" }] }), {
    files: [{ path: "f", text: "u" }],
  });
});
