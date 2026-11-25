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
  useMemo,
  useRef,
  useState,
} from "react";
import { cx } from "./cx.ts";
import { type PartSubmit, submitAll } from "./form-submit.ts";
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
};

const FormContext = createContext<Joined | null>(null);

const SHEET = sheet(
  "form",
  `.copilotz-form { display: flex; flex-direction: column; min-width: 0; margin: 0; }`,
);

export function Form(
  { onSubmit, gap = "md", className, children, ...rest }:
    & {
      /** The form's own save, after its parts': given the values they handed up. */
      onSubmit?(values: Record<string, unknown>, form: HTMLFormElement): unknown;
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
  const busy = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const latest = useRef(onSubmit);
  latest.current = onSubmit;

  // Joining is the same function all along: a part joins once, and keeps its place in the order.
  const join = useCallback((handler: { current: PartSubmit }) => {
    parts.current.add(handler);
    return () => void parts.current.delete(handler);
  }, []);
  const joined = useMemo<Joined>(() => ({ join, submitting, error }), [submitting, error]);

  const submitted = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setError(undefined);
    const form = event.currentTarget;
    const handlers = [...parts.current].map((handler) => (element: HTMLFormElement) =>
      handler.current(element)
    );
    const done = await submitAll(
      form,
      handlers,
      (values, element) => latest.current?.(values, element),
    );
    busy.current = false;
    setSubmitting(false);
    // A failure says its words, or that the form wasn't saved; a part that stopped it said why.
    if (!done.ok && done.failed) setError(done.error ?? say("notSaved"));
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
 * this file). Says whether there is one (`inForm`), and whether it's saving.
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

/** The `Form` around it: whether it's saving, and what stopped its last save. */
export function useFormState(): { inForm: boolean; submitting: boolean; error?: string } {
  const form = useContext(FormContext);
  return { inForm: form !== null, submitting: form?.submitting ?? false, error: form?.error };
}
