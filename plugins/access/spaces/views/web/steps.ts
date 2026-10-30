/**
 * Spaces' steps in the command palette, keyboard first: naming a new space
 * (then opening it, or whatever asked for one: a move there), renaming one
 * (its name ready to type over), and archiving or leaving one, questions
 * that say what they mean before they're done (Enter does it, Escape
 * doesn't).
 */
import { go, type PaletteControl, type PaletteStep } from "../../../../../hosts/web/mod.ts";
import type { Reached } from "../../contract.ts";
import { spacePath } from "./tabs.ts";
import { spaceName } from "./who.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** Names longer than this aren't taken (as `space.rename` says). */
const LONGEST = 60;

/** What a name typed would be, or why it can't. */
const named = (search: string) => {
  const name = search.trim();
  return { name, long: name.length > LONGEST };
};

/** Naming a new space and making it; then `made` (by default, its page opens). */
export function newSpaceStep(
  call: Call,
  made: (space: Reached, palette: PaletteControl) => unknown = (space) => go(spacePath(space._id)),
): PaletteStep {
  return {
    title: "New space",
    placeholder: "Name it",
    note: "A shared space, to work in with others: you'll manage it, and invite them.",
    filter: false,
    items: (search) => {
      const { name, long } = named(search);
      if (!name) return [];
      return [{
        title: "",
        items: [{
          key: "space:create",
          label: `Create “${name}”`,
          icon: "plus",
          disabled: long,
          ...(long ? { description: `At most ${LONGEST} characters` } : {}),
          run: async (palette) => {
            const { space } = await call<{ space: string }>("space.create", { name });
            const fresh: Reached = {
              _id: space,
              name,
              kind: "shared",
              can: ["read", "write", "manage"],
            };
            return await made(fresh, palette);
          },
        }],
      }];
    },
  };
}

/** A new name for a space, typed over its old one. */
export function renameStep(space: Reached, call: Call): PaletteStep {
  return {
    title: `Rename ${space.name}`,
    placeholder: "Its new name",
    value: space.name,
    note: "Everyone in it sees the new name, in the sidebar and on its chats.",
    filter: false,
    items: (search) => {
      const { name, long } = named(search);
      if (!name || name === space.name) return [];
      return [{
        title: "",
        items: [{
          key: "space:rename",
          label: `Rename to “${name}”`,
          icon: "pencil",
          disabled: long,
          ...(long ? { description: `At most ${LONGEST} characters` } : {}),
          run: () => call("space.rename", { space: space._id, name }),
        }],
      }];
    },
  };
}

/** Archiving a space, once they've read what it means. */
export function archiveStep(space: Reached, call: Call): PaletteStep {
  return {
    title: `Archive ${space.name}?`,
    confirm: true,
    note: "It stays readable, as it is, and it's listed apart, under Archived. " +
      "Restore it any time.",
    items: () => [{
      title: "",
      items: [
        {
          key: "space:archive",
          label: `Archive ${space.name}`,
          icon: "archive",
          run: () => call("space.archive", { space: space._id, archived: true }),
        },
        { key: "space:keep", label: "Keep it as it is", icon: "close", run: (p) => p.back() },
      ],
    }],
  };
}

/** Leaving a shared space, once they've read what it means; home after. */
export function leaveStep(space: Reached, call: Call): PaletteStep {
  return {
    title: `Leave ${spaceName(space)}?`,
    confirm: true,
    note: "You'll no longer see its chats, memories or computers; what you added stays there. " +
      "To come back, someone who manages it invites you again.",
    items: () => [{
      title: "",
      items: [
        {
          key: "space:leave",
          label: `Leave ${spaceName(space)}`,
          icon: "signout",
          tone: "destructive",
          run: async () => {
            await call("space.leave", { space: space._id });
            go("/");
          },
        },
        { key: "space:stay", label: "Stay", icon: "close", run: (p) => p.back() },
      ],
    }],
  };
}
