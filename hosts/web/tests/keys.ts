/**
 * The keys of every front end's words, as a Markdown list: `deno run -A hosts/web/tests/keys.ts`
 * writes `hosts/web/WORDS.md`; the words test fails when the file is out of date.
 */
import { writeFileSync } from "node:fs";
import "../../../plugins/agents/web.tsx";
import "../../../plugins/access/web.tsx";
import "../../../plugins/billing/web.tsx";
import "../../../plugins/compute/web.tsx";
import "../../../plugins/interfaces/web.tsx";
import "../mod.ts";
import { knownWords, type Phrase } from "../words.ts";
import { wordsList } from "../../../testing/words.ts";

/**
 * Every front end's words, by key, with its English: what `knownWords` holds, less the words a
 * test defines for itself (`demo`, in words.test.ts). On Bun, test files share one process, so
 * the tests after that one know its words too.
 */
export const frontEndWords = (): Record<string, Phrase> =>
  Object.fromEntries(Object.entries(knownWords()).filter(([key]) => !key.startsWith("demo.")));

export function keysDoc(): string {
  const lines = [
    "# Front-end words",
    "",
    "Every word Copilotz's web front ends show, by key, with its English. An app changes any of",
    'them with a `words` resource (see the README, "Words"). `{name}` is a blank; a phrase in',
    "braces `{one, other}` has plural forms, chosen by the `{count}` blank. Every one of them is",
    "said in Brazilian Portuguese by `ptBR`, from `copilotz/web/pt-br` (hosts/web/pt-br/).",
    "",
    "Generated: `deno run -A hosts/web/tests/keys.ts`.",
    "",
  ];
  lines.push(...wordsList(frontEndWords()));
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  writeFileSync(new URL("../WORDS.md", import.meta.url), keysDoc());
}
