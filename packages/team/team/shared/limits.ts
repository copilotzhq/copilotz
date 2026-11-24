/**
 * How long an agent's instructions may be: the app's setting (the `team` resource's
 * `instructionsLimit`, in characters), else `INSTRUCTIONS_LIMIT`. Every turn sends them, so a
 * limit bounds what one costs; an app whose agents say more raises it.
 */
import { failure, type Resources } from "copilotz";

/** The limit unless the app sets one: 100,000 characters. */
export const INSTRUCTIONS_LIMIT = 100_000;

/** The app's settings for team (`resources.team`). */
export type TeamSettings = {
  /** How long an agent's instructions may be, in characters (100,000). */
  instructionsLimit?: number;
};

/** The limit in force. */
export const instructionsLimitOf = (resources: Resources): number =>
  ((resources.team ?? {}) as TeamSettings).instructionsLimit ?? INSTRUCTIONS_LIMIT;

/** Throws `invalid`, naming the field, when `instructions` are longer than the limit. */
export function checkInstructions(resources: Resources, instructions: string | undefined) {
  const limit = instructionsLimitOf(resources);
  if (instructions && instructions.length > limit) {
    throw Object.assign(
      failure(
        "invalid",
        `Instructions are at most ${limit.toLocaleString("en")} characters; these are ${
          instructions.length.toLocaleString("en")
        }.`,
        { public: true },
      ),
      { detail: { field: "instructions" } },
    );
  }
}
