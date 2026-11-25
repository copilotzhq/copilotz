/**
 * Steps of a session with a mounted date picker, as a person takes them: open it, type into its
 * fields, pick days, press keys, leave a field, and click its buttons. happy-dom has no popovers,
 * so opening and closing are the component's own handlers, with the browser's half a no-op.
 */
import { act, type ReactNode } from "react";
import { page } from "./page.ts";

const nth = <T extends HTMLElement>(selector: string, index = 0): T => {
  const found = document.querySelectorAll<T>(selector)[index];
  if (!found) throw new Error(`No ${selector} #${index}`);
  return found;
};

/** Types text into an input as a person does: its value changes, then React hears `input`. */
export const type = (selector: string, index: number, text: string) =>
  act(async () => {
    const input = nth<HTMLInputElement>(selector, index);
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });

/** Clicks the element a selector finds (the `index`th). */
export const click = (selector: string, index = 0) => act(async () => nth(selector, index).click());

/** Clicks the button that says `text`. */
export const press = (text: string) =>
  act(async () => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent === text);
    if (!button) throw new Error(`No button ${text}`);
    button.click();
  });

/** Presses a key in an element. */
export const key = (selector: string, index: number, name: string) =>
  act(async () => {
    nth(selector, index).dispatchEvent(
      new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
    );
  });

/** Leaves a field. */
export const blur = (selector: string, index = 0) =>
  act(async () => {
    nth(selector, index).dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  });

/** The From and To fields' inputs. */
export const ENDS = ".copilotz-date-end-input input";

/** The texts a field holds as a person types `target` from empty, a character at a time. */
export const fromEmpty = (target: string): string[] =>
  [...target].map((_, i, all) => all.slice(0, i + 1).join(""));

/**
 * The texts a field holds as a person retypes `old` into `target`: each run of digits, or of other
 * characters, that differs, deleted and typed again a character at a time.
 */
export function retyped(old: string, target: string): string[] {
  const runs = (text: string) => text.match(/\p{Nd}+|\P{Nd}+/gu) ?? [];
  const [now, next] = [runs(old), runs(target)];
  if (now.length !== next.length) return fromEmpty(target);
  const out: string[] = [];
  for (const [i, run] of next.entries()) {
    if (now[i] === run) continue;
    for (let k = 0; k <= [...run].length; k++) {
      now[i] = [...run].slice(0, k).join("");
      out.push(now.join(""));
    }
  }
  return out;
}

/** A step: its name and what it does. */
export type Step = [name: string, run: () => Promise<void>];

/**
 * The page's markup, its React ids numbered in the order they appear: React counts ids across
 * every root a process makes, so two sessions' ids differ though their pages are the same.
 */
function markup(): string {
  const ids = new Map<string, string>();
  return document.documentElement.innerHTML.replace(
    /_r_[0-9a-z]+_|:r[0-9a-z]+:|«r[0-9a-z]+»/g,
    (id) => {
      if (!ids.has(id)) ids.set(id, `«id${ids.size}»`);
      return ids.get(id)!;
    },
  );
}

/**
 * A session: the picker mounted in a page of the given language, then each step. What's recorded
 * after the first render and each step: the page's markup and the values `onChange` was called
 * with since; and at the end, after it's unmounted, the calls unmounting made.
 */
export async function session(
  make: (onChange: (value: unknown) => void) => ReactNode,
  steps: Step[],
  lang = "en",
): Promise<[string, string, unknown[]][]> {
  const out: [string, string, unknown[]][] = [];
  await page(async (render) => {
    document.documentElement.lang = lang;
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    proto.showPopover = () => {};
    proto.hidePopover = () => {};
    const calls: unknown[] = [];
    await render(make((value) => calls.push(value)));
    out.push(["render", markup(), calls.splice(0)]);
    for (const [name, run] of steps) {
      await run();
      out.push([name, markup(), calls.splice(0)]);
    }
    await render(null);
    out.push(["unmount", markup(), calls.splice(0)]);
  });
  return out;
}
