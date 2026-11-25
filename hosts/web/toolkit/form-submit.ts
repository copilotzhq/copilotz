/**
 * A form's submit, as `Form` runs it (see form.tsx): the handlers its parts
 * joined with (`useFormSubmit`), in the order they joined, then its own. Each
 * part's handler checks what it holds and either hands its values up (an
 * object, merged into what the form's own handler gets), says nothing (it
 * saved its own part, or has nothing to add), or stops the save: `false`
 * (the part shows why itself) or a throw (the form says its words). Nothing
 * after a stop runs, so the form's own save happens only when every part
 * agreed.
 */

/** What a part's handler gives back: values for the form's own, `false` to stop, or nothing. */
export type PartAnswer = Record<string, unknown> | false | void | undefined;

/** A part's handler, given the form's element. */
export type PartSubmit = (form: HTMLFormElement) => PartAnswer | Promise<PartAnswer>;

/** How a submit ended: saved, or stopped (with the words to say, when a throw gave some). */
export type Submitted =
  | { ok: true; values: Record<string, unknown> }
  /** Stopped: by a part that said why (`false`), or by a failure (`failed`), with its words if any. */
  | { ok: false; failed?: true; error?: string };

/** The words a thrown failure carries, for people: its message, or nothing. */
export const wordsOf = (error: unknown): string | undefined => {
  const message = typeof error === "string"
    ? error
    : error instanceof Error || (typeof error === "object" && error !== null && "message" in error)
    ? String((error as { message: unknown }).message)
    : undefined;
  return message?.trim() ? message.trim() : undefined;
};

/** Runs a submit: every part's handler in order, then the form's own with what they handed up. */
export async function submitAll(
  form: HTMLFormElement,
  parts: PartSubmit[],
  own?: (values: Record<string, unknown>, form: HTMLFormElement) => unknown,
): Promise<Submitted> {
  const values: Record<string, unknown> = {};
  try {
    for (const part of parts) {
      const answer = await part(form);
      if (answer === false) return { ok: false };
      if (answer && typeof answer === "object") Object.assign(values, answer);
    }
    await own?.(values, form);
    return { ok: true, values };
  } catch (error) {
    const said = wordsOf(error);
    return said ? { ok: false, failed: true, error: said } : { ok: false, failed: true };
  }
}
