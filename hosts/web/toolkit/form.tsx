/**
 * A form whose parts take part in its save, even a View another plugin
 * shows inside it (a settings tab's form, and in it a panel of reward
 * packages): one Submit saves them all, as one form.
 *
 * Each part joins with `useFormSubmit(handler)`. On submit (its button, or
 * Enter in a field), the form runs every part's handler in the order they
 * joined, then its own `onSubmit` with what they handed up (see
 * form-submit.ts): a handler returns values (merged into `onSubmit`'s), or
 * nothing (it saved its own part), or `false` to stop the save (the part
 * says why), or throws (the form says its words, at its top, as an alert).
 * Async handlers are waited for; the browser's own checks (`required`) run
 * first. While it saves, `useFormState()` says so (`submitting`), for its
 * buttons; a second submit meanwhile is ignored.
 *
 * A failure about one field (`detail.field`: a schema's refusal of a save,
 * or an Action's `failure` with a `detail`) shows under the `Field` of that
 * `name`, or at the top when no field has it. A schema's words are for
 * developers: `errors` gives people's, by field (`{ price: "Give the price
 * as a number." }`).
 *
 * A part shown inside another plugin's form (a View, through `ctx.show`) is
 * in that form's React tree, so it finds it. Outside any `Form`,
 * `useFormSubmit` says so (`inForm: false`), and the part shows a Submit of
 * its own. Saving everything together in one Action (one transaction) is
 * the safest: hand values up, and let `onSubmit` save them; a part that
 * saves its own part saves it whatever comes after.
 *
 * It lays its children out as a `Stack` does (`gap`, `md` by default).
 *
 * ```tsx
 * <Form onSubmit={(values, form) =>
 *   ctx.call("rewards.save", { on: new FormData(form).has("on"), packages: values.packages })}>
 *   <Field label="Enable rewards" htmlFor="on"><Checkbox id="on" name="on" /></Field>
 *   {ctx.show("panel:reward_packages", {})}
 *   <Button type="submit" variant="primary">Save</Button>
 * </Form>
 *
 * // The panel, another plugin's View:
 * const { inForm } = useFormSubmit(() => (valid(rows) ? { packages: rows } : false));
 * ```
 */
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cx } from "./cx.ts";
import { fieldFor, type PartSubmit, submitAll } from "./form-submit.ts";
import { say } from "./words.ts";
import { Notice } from "./notice.tsx";
import { sheet } from "./sheet.tsx";
import { gapClass, GAPS, type Space } from "./space.tsx";
import type { FormAttributes } from "./stack.tsx";

export type { PartAnswer, PartSubmit } from "./form-submit.ts";

/** What a form tells its parts. */
type Joined = {
  join(handler: { current: PartSubmit }): () => void;
  submitting: boolean;
  error?: string;
  /** A field shows the refusals about it, by name, while it's there: gives back what lets go. */
  claim(name: string): () => void;
  /** What its last save's refusal says, by the field it shows under. */
  refused: Record<string, string>;
};

const NOTHING: Record<string, string> = {};

const FormContext = createContext<Joined | null>(null);

const SHEET = sheet(
  "form",
  `.copilotz-form { display: flex; flex-direction: column; min-width: 0; margin: 0; }`,
);

export function Form(
  { onSubmit, onSubmittingChange, errors, gap = "md", className, children, ...rest }:
    & {
      /** The form's own save, after its parts': given the values they handed up. */
      onSubmit?(
        values: Record<string, unknown>,
        form: HTMLFormElement,
        signal: AbortSignal,
      ): unknown;
      /** Busy from the first part until the save finishes or the form unmounts. */
      onSubmittingChange?(busy: boolean, form: HTMLFormElement): void;
      /**
       * People's words for a field a save refuses, by its name (`detail.field`): said instead of
       * the refusal's own (a schema's are for developers).
       */
      errors?: Record<string, string>;
      gap?: Space;
      className?: string;
      children?: ReactNode;
      id?: string;
      "aria-label"?: string;
      "aria-labelledby"?: string;
    }
    & FormAttributes,
): ReactNode {
  const parts = useRef(new Set<{ current: PartSubmit }>());
  const attempt = useRef<AbortController | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useLayoutEffect(() => {
    // Activity preserves state while hidden and reconnects this effect when shown.
    setSubmitting(attempt.current !== null);
    return () => {
      attempt.current?.abort();
      attempt.current = null;
    };
  }, []);
  const [error, setError] = useState<string>();
  const [refused, setRefused] = useState(NOTHING);
  /** The fields shown, by name: how many of each. */
  const names = useRef(new Map<string, number>());

  // Joining is the same function all along: a part joins once, and keeps its place in the order.
  const join = useCallback((handler: { current: PartSubmit }) => {
    parts.current.add(handler);
    return () => void parts.current.delete(handler);
  }, []);
  const claim = useCallback((name: string) => {
    names.current.set(name, (names.current.get(name) ?? 0) + 1);
    return () => {
      const left = (names.current.get(name) ?? 1) - 1;
      if (left > 0) names.current.set(name, left);
      else names.current.delete(name);
    };
  }, []);
  const joined = useMemo<Joined>(
    () => ({ join, submitting, error, claim, refused }),
    [submitting, error, refused],
  );

  const submitted = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (attempt.current) return;
    const controller = new AbortController();
    attempt.current = controller;
    setSubmitting(true);
    setError(undefined);
    setRefused(NOTHING);
    const form = event.currentTarget;
    const handlers = [...parts.current].map((handler) => handler.current);
    const { signal } = controller;
    const finished = () => onSubmittingChange?.(false, form);
    const done = await submitAll(
      form,
      handlers,
      (values) => onSubmit?.(values, form, signal),
      signal,
      () => {
        signal.addEventListener("abort", finished, { once: true });
        onSubmittingChange?.(true, form);
      },
    );
    if (signal.aborted) return;
    attempt.current = null;
    setSubmitting(false);
    signal.removeEventListener("abort", finished);
    finished();
    // A failure says its words, or that the form wasn't saved; a part that stopped it said why.
    if (!done.ok && done.failed) {
      const at = done.field === undefined ? undefined : fieldFor(done.field, names.current.keys());
      const own = done.field === undefined
        ? undefined
        : errors?.[at ?? done.field] ?? errors?.[done.field];
      const said = own ?? done.error ?? say("notSaved");
      if (at) setRefused({ [at]: said });
      else setError(said);
    }
  };

  return (
    <form
      {...rest}
      className={cx("copilotz-form", gapClass(gap), className)}
      aria-busy={submitting || undefined}
      onSubmit={submitted}
    >
      {SHEET}
      {GAPS}
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      <FormContext.Provider value={joined}>{children}</FormContext.Provider>
    </form>
  );
}

/**
 * Joins the `Form` around it: `handler` runs on its submit (see the top of
 * this file). It receives the live form and this attempt's AbortSignal. After each await,
 * check signal.aborted before touching the form. Says whether there is a form
 * (`inForm`), and whether it's saving.
 */
export function useFormSubmit(
  handler: PartSubmit,
): { inForm: boolean; submitting: boolean } {
  const form = useContext(FormContext);
  const latest = useRef(handler);
  latest.current = handler;
  const join = form?.join;
  useEffect(() => join?.(latest), [join]);
  return { inForm: form !== null, submitting: form?.submitting ?? false };
}

/**
 * What the `Form` around it refused of the field `name` at its last save (its words), if
 * anything; while it's drawn, the form shows refusals of that field here, not at its top.
 * `Field` uses it, given a `name`.
 */
export function useRefusal(name: string | undefined): string | undefined {
  const form = useContext(FormContext);
  const claim = form?.claim;
  useEffect(() => (name && claim ? claim(name) : undefined), [name, claim]);
  return name ? form?.refused[name] : undefined;
}

/** The `Form` around it: whether it's saving, and what stopped its last save. */
export function useFormState(): { inForm: boolean; submitting: boolean; error?: string } {
  const form = useContext(FormContext);
  return { inForm: form !== null, submitting: form?.submitting ?? false, error: form?.error };
}
