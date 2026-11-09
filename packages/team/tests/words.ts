/**
 * The keys of team's front-end words, as a Markdown list:
 * `deno run -A packages/team/tests/words.ts` writes its WORDS.md; its words test fails when the
 * file is out of date.
 */
import { writeFileSync } from "node:fs";
import { keyed, wordsList } from "copilotz/testing/words";
import { PHRASES } from "../team/views/web/words.ts";

export function wordsDoc(): string {
  const words = Object.assign({}, ...Object.entries(PHRASES).map(([area, p]) => keyed(area, p)));
  return [
    "# @copilotz/team's words",
    "",
    "Every word team's and tiers' web front ends show, by key, with its English. An app changes any",
    'of them with a `words` resource (see Copilotz\'s README, "Words"). `{name}` is a blank; a phrase',
    "in braces `{one, other}` has plural forms, chosen by the `{count}` blank.",
    "",
    "Generated: `deno run -A packages/team/tests/words.ts`.",
    "",
    ...wordsList(words),
  ].join("\n") + "\n";
}

if (import.meta.main) {
  writeFileSync(new URL("../WORDS.md", import.meta.url), wordsDoc());
}
