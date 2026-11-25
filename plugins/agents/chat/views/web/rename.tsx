/**
 * Renaming a chat (`chat.rename`), as a command palette step: its title,
 * ready to type over, then "Rename to “…”". Every way to rename a chat comes
 * here: its header's menu, a list's row, the palette.
 */
import type { PaletteStep } from "../../../../../hosts/web/mod.ts";
import { LONGEST_TITLE } from "../../shared/types.ts";
import { shortened } from "./plain.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export function renameStep(
  { thread, title, call }: { thread: string; title: string; call: Call },
): PaletteStep {
  return {
    title: say("renameTitle", { title: shortened(title) }),
    placeholder: say("renamePlaceholder"),
    value: title,
    note: say("renameNote"),
    filter: false,
    items: (search) => {
      const next = search.replace(/\s+/g, " ").trim();
      if (!next || next === title) return [];
      const long = next.length > LONGEST_TITLE;
      return [{
        title: "",
        items: [{
          key: "chat:rename",
          label: say("renameTo", { title: shortened(next, 60) }),
          icon: "pencil",
          disabled: long,
          ...(long ? { description: say("titleAtMost", { count: LONGEST_TITLE }) } : {}),
          run: () => call("chat.rename", { thread, title: next }),
        }],
      }];
    },
  };
}
