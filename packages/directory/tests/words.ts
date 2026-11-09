/**
 * The keys of the directory's front-end words, as a Markdown list:
 * `deno run -A packages/directory/tests/words.ts` writes its WORDS.md; its words test fails when
 * the file is out of date.
 */
import { writeFileSync } from "node:fs";
import { keyed, wordsList } from "copilotz/testing/words";
import { PHRASES } from "../views/web/words.ts";

export function wordsDoc(): string {
  const words = Object.assign({}, ...Object.entries(PHRASES).map(([area, p]) => keyed(area, p)));
  return [
    "# @copilotz/directory's words",
    "",
    "Every word the directory's web front end shows (the org switcher, the org's page, staff's",
    "console), by key, with its English. An app changes any of them with a `words` resource (see",
    'Copilotz\'s README, "Words"). They keep the keys they had in the web shell (`shell.<key>`), beside',
    "the shell's own (Copilotz's hosts/web/WORDS.md). `{name}` is a blank; a phrase in braces",
    "`{one, other}` has plural forms, chosen by the `{count}` blank.",
    "",
    "Generated: `deno run -A packages/directory/tests/words.ts`.",
    "",
    ...wordsList(words),
  ].join("\n") + "\n";
}

if (import.meta.main) {
  writeFileSync(new URL("../WORDS.md", import.meta.url), wordsDoc());
}
