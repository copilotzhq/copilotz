/**
 * A Personal space is its person's alone: agents join it, to work there for
 * them, and their keys, and nobody else does. Working with others is what
 * shared spaces are for.
 */
export const PERSONAL = "personal";

const alone = () =>
  Object.assign(
    new Error("A Personal space is its person's alone: make a shared space to work with others."),
    { code: "forbidden" },
  );

/** Throws unless `member` (`person:bob`) may join `space`: a personal one, only agents and keys. */
export function joinable(space: Record<string, unknown> | null | undefined, member: string) {
  if (space?.kind === PERSONAL && !member.startsWith("agent:") && !member.startsWith("key:")) {
    throw alone();
  }
}
