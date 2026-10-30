/**
 * What an agent waits on its person for, in words: "assistant wants to run
 * `npm test`", "write `src/a.ts`", "start `npm run dev`". The verb comes
 * from the kind of work (and, for a write, from its detail: `write <path>`
 * or `edit <path>`); `what` is the command or the path, shown as code. And
 * a write's `preview`, as lines to show: what a new file will say, or what
 * an edit changes (a diff's `+` and `-` lines, as added and removed).
 */

export type Asking = { agent: string; work: string; detail: string };

export type Asked = {
  /** "wants to run", "wants to write"… */
  wants: string;
  /** The command, or the file. */
  what: string;
  /** The verb alone: "run", "write", "start". */
  verb: string;
};

export function asked({ work, detail }: Asking): Asked {
  if (work === "terminal") return { verb: "run", wants: "wants to run", what: detail };
  if (work === "jobs") return { verb: "start", wants: "wants to start", what: detail };
  if (work === "writes") {
    const [, verb, path] = /^(write|edit)\s+([\s\S]+)$/.exec(detail) ?? [];
    return verb
      ? { verb, wants: `wants to ${verb}`, what: path }
      : { verb: "change", wants: "wants to change", what: detail };
  }
  return { verb: work, wants: `wants to use ${work} for`, what: detail };
}

/** The whole sentence, as a notice or a screen reader says it. */
export const sentence = (a: Asking): string => {
  const { wants, what } = asked(a);
  return `${a.agent} ${wants} ${what}`;
};

/** What a yes covers, for whoever's deciding: this once, in this conversation, or always. */
export function reach(
  answer: "once" | "thread" | "always",
  a: Asking,
  computer = "this computer",
): string {
  const { verb, what } = asked(a);
  const doing = { terminal: "run commands", jobs: "start jobs", writes: "change files" }[a.work] ??
    `use ${a.work}`;
  if (answer === "once") return `${a.agent} may ${verb} ${what}, this once.`;
  const where = answer === "thread" ? "in this conversation" : "in any conversation";
  return `${a.agent} may ${doing} on ${computer} without asking again, ${where}.`;
}

/** A line of a preview, as a code block shows it. */
export type PreviewPart = { text: string; tone?: "added" | "removed" | "muted" };

/** Where a preview was cut short, as the program marks it. */
const CUT = "…";

/**
 * A write's preview (`approval.preview`, made by the computer tools) as
 * lines to show: a new file's first lines, as added lines; an edit's change
 * (`- old line`, `+ new line`), as removed and added lines, their marks
 * taken off; anything else as it is. Where it was cut short (`…`), muted.
 */
export function previewOf(preview: string, verb = "write"): PreviewPart[] {
  const lines = preview.replace(/\n$/, "").split("\n");
  const cut = lines.at(-1) === CUT ? lines.pop() : undefined;
  const marked = (l: string) => /^[+-]( |$)/.test(l);
  const parts: PreviewPart[] = verb === "edit" && lines.every(marked)
    ? lines.map((l) => ({
      text: `${l.slice(2)}\n`,
      tone: l.startsWith("+") ? "added" : "removed",
    }))
    : [{ text: `${lines.join("\n")}\n`, ...(verb === "edit" ? {} : { tone: "added" as const }) }];
  return cut ? [...parts, { text: `${CUT}\n`, tone: "muted" }] : parts;
}
