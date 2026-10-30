/**
 * What people type in WhatsApp besides talking: `/new` (a new
 * conversation), `/space` (which space, and the others), `/space <name>`
 * (talk in another), `/help`. Only these are commands: "/etc/hosts is
 * broken" is a message like any other. What they answer, in words.
 */

export type Command = { name: "new" | "space" | "help"; arg: string };

const NAMES: Record<string, Command["name"]> = {
  new: "new",
  space: "space",
  spaces: "space",
  help: "help",
  start: "help",
};

/** The command a message is, if it's one. */
export function commandOf(text: string): Command | undefined {
  const found = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = found && NAMES[found[1].toLowerCase()];
  return name ? { name, arg: (found[2] ?? "").trim() } : undefined;
}

/** A space as the person picks it: by name, or "Personal" for their own. */
export type Named = { _id: string; name: string; kind?: string; archived?: string };

/**
 * The space a name means among those someone reaches: the one called that
 * (any case), else the only one whose name starts with it, else the only
 * one whose name has it. Their Personal space answers to "personal".
 */
export function pickSpace(spaces: Named[], wanted: string): Named | undefined {
  const name = (s: Named) => (s.kind === "personal" ? "Personal" : s.name).toLowerCase();
  const asked = wanted.trim().toLowerCase();
  const open = spaces.filter((s) => !s.archived);
  const only = (found: Named[]) => (found.length === 1 ? found[0] : undefined);
  return only(open.filter((s) => name(s) === asked)) ??
    only(open.filter((s) => name(s).startsWith(asked))) ??
    only(open.filter((s) => name(s).includes(asked)));
}

export const spaceName = (s: Named) => s.kind === "personal" ? "Personal" : s.name;

export const HELP = [
  "*Here's how this works*",
  "• Just write: your agents answer here.",
  "• Photos, documents and voice notes reach them too.",
  "• /new: start a new conversation",
  "• /space: see where you're talking, and your spaces",
  "• /space <name>: talk in another space",
  "• /help: this list",
].join("\n");
