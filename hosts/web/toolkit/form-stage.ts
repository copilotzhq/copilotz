import { trackControls } from "./form-values.ts";

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const selector = "input, textarea, select";

/** Seed a copy with the live property. Only a change made to the copy is written back. */
function property<T, K extends keyof T>(original: T, copy: T, key: K) {
  const initial = original[key];
  copy[key] = initial;
  return (live: T) => {
    if (copy[key] !== initial) live[key] = copy[key];
  };
}

function stageControl(original: Control, copy: Control): (live: Control) => void {
  if ("options" in original && "options" in copy) {
    // cloneNode copies option attributes, which can differ from the current selection.
    const options = Array.from(original.options);
    const track = trackControls(options, (option) => option.value);
    const changes = options.map((option, i) => property(option, copy.options[i], "selected"));
    return (live) => {
      if (!("options" in live)) return;
      const resolve = track(Array.from(live.options));
      options.forEach((option, i) => {
        const target = resolve(option);
        if (target) changes[i](target);
      });
    };
  }
  if ("files" in original && "files" in copy) {
    if (original.type === "file") {
      const files = property(original, copy, "files");
      return (live) => files(live as HTMLInputElement);
    }
    const checked = property(original, copy, "checked");
    const value = property(original, copy, "value");
    return (live) => {
      checked(live as HTMLInputElement);
      value(live as HTMLInputElement);
    };
  }
  return property(original, copy, "value");
}

/** Parts share a private form for one attempt. Commit its edited controls only after all agree. */
export function stageForm(form: HTMLFormElement) {
  const document = form.ownerDocument.implementation.createHTMLDocument();
  const copy = document.body.appendChild(document.importNode(form, true));
  const originals = Array.from(form.querySelectorAll<Control>(selector));
  const clones = copy.querySelectorAll<Control>(selector);
  const pairs = new Map(originals.map((c, i) => [c, clones[i]]));
  const changes = new Map<Control, (live: Control) => void>();
  for (const element of Array.from(form.elements)) {
    if (!element.matches(selector)) continue;
    const control = element as Control;
    // An input associated by form="…" can live outside the form's subtree.
    const clone = pairs.get(control) ?? copy.appendChild(document.importNode(control, true));
    changes.set(control, stageControl(control, clone));
  }
  const track = trackControls([...changes.keys()]);
  return {
    form: copy,
    commit() {
      const resolve = track(Array.from(form.elements) as Control[]);
      for (const [control, change] of changes) {
        const live = resolve(control);
        if (live) change(live);
      }
    },
  };
}
