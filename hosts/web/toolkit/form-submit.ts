/**
 * A form's submit, as `Form` runs it (see form.tsx): the handlers its parts
 * joined with (`useFormSubmit`), in the order they joined, then its own. Each
 * part's handler checks what it holds and either hands its values up (an
 * object, merged into what the form's own handler gets), says nothing (it
 * saved its own part, or has nothing to add), or stops the save: `false`
 * (the part shows why itself) or a throw (the form says its words). Nothing
 * after a stop runs, so the form's own save happens only when every part
 * agreed. A failure about one field (`detail.field`, as a schema's refusal
 * and an Action's `failure` with a `detail` say it) says which.
 */
import { stageForm } from "./form-stage.ts";

/** What a part's handler gives back: values for the form's own, `false` to stop, or nothing. */
export type PartAnswer = Record<string, unknown> | false | void | undefined;

/** A part's handler, given this attempt's working copy of the form and its cancellation signal. */
export type PartSubmit = (
  form: HTMLFormElement,
  signal: AbortSignal,
) => PartAnswer | Promise<PartAnswer>;

/** How a submit ended: saved, or stopped (with the words to say, when a throw gave some). */
export type Submitted =
  | { ok: true; values: Record<string, unknown> }
  /**
   * Stopped: by a part that said why (`false`), or by a failure (`failed`), with its words if
   * any, and the field it's about (`detail.field`) if it names one.
   */
  | { ok: false; failed?: true; error?: string; field?: string };

/** The words a thrown failure carries, for people: its message, or nothing. */
export const wordsOf = (error: unknown): string | undefined => {
  const message = typeof error === "string"
    ? error
    : error instanceof Error || (typeof error === "object" && error !== null && "message" in error)
    ? String((error as { message: unknown }).message)
    : undefined;
  return message?.trim() ? message.trim() : undefined;
};

/**
 * The field a failure is about, if it names one: `detail.field`, a dot path (`price`,
 * `lines.0.quantity`), as a schema's refusal and an Action's `failure(…)` with a `detail` carry it.
 */
export const fieldOf = (error: unknown): string | undefined => {
  const field = (error as { detail?: { field?: unknown } } | null)?.detail?.field;
  return typeof field === "string" && field !== "" ? field : undefined;
};

/**
 * Of the fields a form shows, by name, the one a refusal about `field` goes under: that field, or
 * the nearest one it's part of (`lines.0.quantity` under `lines`); none when no field holds it.
 */
export function fieldFor(field: string, names: Iterable<string>): string | undefined {
  let found: string | undefined;
  for (const name of names) {
    const holds = field === name || field.startsWith(`${name}.`);
    if (holds && (found === undefined || name.length > found.length)) found = name;
  }
  return found;
}

/** Runs a submit: every part's handler in order, then the form's own with what they handed up. */
export async function submitAll(
  form: HTMLFormElement,
  parts: PartSubmit[],
  own?: (values: Record<string, unknown>, form: HTMLFormElement) => unknown,
  signal = new AbortController().signal,
  start?: () => void,
): Promise<Submitted> {
  const values: Record<string, unknown> = {};
  try {
    start?.();
    if (signal.aborted) return { ok: false };
    if (parts.length) {
      const stage = stageForm(form);
      for (const part of parts) {
        const answer = await part(stage.form, signal);
        if (signal.aborted || answer === false) return { ok: false };
        if (answer && typeof answer === "object") Object.assign(values, answer);
      }
      stage.commit();
    }
    await own?.(values, form);
    return { ok: true, values };
  } catch (error) {
    const said = wordsOf(error);
    const field = fieldOf(error);
    return {
      ok: false,
      failed: true,
      ...(said ? { error: said } : {}),
      ...(field ? { field } : {}),
    };
  }
}
