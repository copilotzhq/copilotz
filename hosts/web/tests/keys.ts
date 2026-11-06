/**
 * The keys of every front end's words, as a Markdown list: `deno run -A hosts/web/tests/keys.ts`
 * writes `hosts/web/WORDS.md`; the words test fails when the file is out of date.
 */
import { writeFileSync } from "node:fs";
import "../../../plugins/agents/web.tsx";
import "../../../plugins/access/web.tsx";
import "../../../plugins/billing/web.tsx";
import "../../../plugins/interfaces/web.tsx";
import "../mod.ts";
import { knownWords } from "../words.ts";

export function keysDoc(): string {
  const lines = [
    "# Front-end words",
    "",
    "Every word Copilotz's web front ends show, by key, with its English. An app changes any of",
    'them with a `words` resource (see the README, "Words"). `{name}` is a blank; a phrase in',
    "braces `{one, other}` has plural forms, chosen by the `{count}` blank.",
    "",
    "Generated: `deno run -A hosts/web/tests/keys.ts`.",
    "",
  ];
  let area = "";
  for (const [key, phrase] of Object.entries(knownWords()).sort(([a], [b]) => a.localeCompare(b))) {
    const [head] = key.split(".");
    if (head !== area) {
      lines.push("", `## ${head}`, "", "| Key | English |", "|---|---|"), area = head;
    }
    const english = typeof phrase === "string"
      ? phrase
      : Object.entries(phrase).map(([form, text]) => `${form}: ${text}`).join(" / ");
    lines.push(`| \`${key}\` | ${english.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
  }
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  writeFileSync(new URL("../WORDS.md", import.meta.url), keysDoc());
}
