/** Collects trusted static prompt instructions from Core composition. @module */

import {
  isPromptInstructionResource,
  type PromptInstructionResource,
} from "../index.ts";

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]!.codePointAt(0)! -
      rightPoints[index]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

/** Reads the composed trusted instruction Resources in stable identity order. */
export function collectPromptInstructions(
  resources: Readonly<Record<string, unknown> | undefined>,
): readonly PromptInstructionResource[] {
  const values: PromptInstructionResource[] = [];
  for (const [alias, value] of Object.entries(resources ?? {})) {
    if (value === undefined) continue;
    if (!isPromptInstructionResource(value)) {
      throw new TypeError(
        `Prompt instruction resource '${alias}' is not a canonical data Resource.`,
      );
    }
    values.push(value);
  }
  values.sort((left, right) => compareCodePoints(left.id, right.id));
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]?.id === values[index]?.id) {
      throw new TypeError(
        `Duplicate prompt instruction resource '${values[index]?.id}'.`,
      );
    }
  }
  return Object.freeze(values);
}
