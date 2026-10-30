/**
 * Spaces' folders under the computer's root, and whose work is whose. The
 * plugin sets the scope from what it trusts; here it's only checked for
 * shape: a folder is one plain segment (never hidden, so `.copilotz` stays
 * the program's own), and `who` names someone.
 */
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Scope } from "../../shared/workloads.ts";
import { fail } from "./answer.ts";

export type Spaces = {
  /** The computer's root, as a real path. */
  root: string;
  /** A space's folder, as a real path: made the first time it's used. */
  folder(scope: Scope): Promise<string>;
  /** One key per folder and who, for what's theirs (shells, jobs, browser contexts). */
  key(scope: Scope): string;
};

/** A scope as the plugin sent it, checked. */
export function checkScope(value: unknown): Scope {
  const scope = value as Partial<Scope> | undefined;
  if (!scope || typeof scope !== "object") fail("scope is required");
  const { space, folder, who } = scope;
  if (typeof space !== "string" || !space) fail("scope.space is required");
  if (
    typeof folder !== "string" || !folder || folder.length > 255 || folder.startsWith(".") ||
    /[/\\\0]/.test(folder)
  ) fail("scope.folder must be one plain folder name");
  if (typeof who !== "string" || !who || who.length > 512) fail("scope.who is required");
  return { space, folder, who };
}

/** The spaces under `root` (a real path). */
export function createSpaces(root: string): Spaces {
  const made = new Map<string, Promise<string>>();
  return {
    root,
    folder(value) {
      const { folder } = checkScope(value);
      let real = made.get(folder);
      if (!real) {
        const path = join(root, folder);
        real = mkdir(path, { recursive: true }).then(() => realpath(path));
        // A folder that couldn't be made is tried again next time.
        real.catch(() => made.delete(folder));
        made.set(folder, real);
      }
      return real;
    },
    key: (value) => {
      const { folder, who } = checkScope(value);
      return `${folder}\u0000${who}`;
    },
  };
}
