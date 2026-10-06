/** Declarative root, inline, and packaged Skill resources. @module */
import {
  type CompositionContribution,
  contribution,
} from "@copilotz/copilotz/plugins";
import { skillsPlugin } from "../../plugin.ts";
import {
  createBundledSkill,
  createInlineSkill,
  type DefineInlineSkillInput as InlineSkillInput,
  type DefineSkillInput as BundledSkillInput,
} from "../../resources/skill/index.ts";
import type { Skill } from "../../shared/contracts.ts";
import { createRootSkill } from "../../shared/snapshots.ts";
import { type SkillRootInput, validateRoot } from "../../shared/root-reader.ts";

export type DefineSkillInput =
  | SkillRootInput
  | InlineSkillInput
  | BundledSkillInput;
export type DefinedSkill = CompositionContribution<
  Skill,
  {},
  readonly [typeof skillsPlugin]
>;

/** No I/O at declaration; authorized catalogs read root metadata on demand. */
export function defineSkill(input: DefineSkillInput): DefinedSkill {
  if (!input || typeof input !== "object") {
    throw new TypeError("Skill definition must be an object.");
  }
  const root = "root" in input
    ? { ...input, root: validateRoot(input.root) }
    : undefined;
  const bundled = root
    ? undefined
    : "markdown" in input
    ? createInlineSkill(input)
    : createBundledSkill(input as BundledSkillInput);
  const values = new Map<string, Skill>();
  return Object.freeze({
    [contribution]({ namespace, alias }: { namespace: string; alias: string }) {
      if (namespace !== "skills") {
        throw new TypeError("Skill definitions belong in resources.skills.");
      }
      if (bundled && bundled.name !== alias) {
        throw new TypeError(
          `Skill '${bundled.name}' must be registered as '${bundled.name}'.`,
        );
      }
      let value = values.get(alias);
      if (!value) {
        value = bundled ?? createRootSkill(alias, root!);
        values.set(alias, value);
      }
      return { value, plugins: [skillsPlugin] as const };
    },
  });
}
