/**
 * What an agent waits on its person for, in words: "assistant wants to run
 * `npm test`", "write `src/a.ts`", "start `npm run dev`", "publish Shop".
 * The verb comes from the kind of work (and, for a write, from its detail:
 * `write <path>` or `edit <path>`); `what` is the command, the path or the
 * app's name. A publish's detail says what it's from (`publish <name> from
 * job <job> on port <port> from <folder>`), and its `preview`, when it's an
 * address, where it'll be. And a write's `preview`, as lines to show: what
 * a new file will say, or what an edit changes (a diff's `+` and `-` lines,
 * as added and removed).
 */

export type Asking = {
  agent: string;
  work: string;
  detail: string;
  preview?: string;
  /** What set it going, when no person there did (a routine). */
  origin?: { kind: string; name: string };
};

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
  if (work === "publish") {
    return { verb: "publish", wants: "wants to publish", what: publishOf(detail).name };
  }
  return { verb: work, wants: `wants to use ${work} for`, what: detail };
}

/** What an agent asks to publish, from its detail: the app's name, and the job, port and folder it's from. */
export type Publishing = { name: string; job?: string; port?: number; path?: string };

export function publishOf(detail: string): Publishing {
  const rest = /^publish\s+([\s\S]+)$/.exec(detail)?.[1] ?? detail;
  // As it's written: `<name>[ from job <job>][ on port <port>][ from <folder>]`.
  const at = rest.search(/ (from job \S+|on port \d+|from \S+)( |$)/);
  const name = (at < 0 ? rest : rest.slice(0, at)).trim();
  const tail = at < 0 ? "" : rest.slice(at);
  const job = / from job (\S+)/.exec(tail)?.[1];
  const port = / on port (\d+)/.exec(tail)?.[1];
  const path = / from (?!job )(\S+)/.exec(tail)?.[1];
  return {
    name: name || rest,
    ...(job ? { job } : {}),
    ...(port ? { port: Number(port) } : {}),
    ...(path ? { path } : {}),
  };
}

/** Where a publish will be, when its `preview` says (an address). */
export const addressOf = (a: Pick<Asking, "work" | "preview">): string | undefined =>
  a.work === "publish" && a.preview && /^https?:\/\/\S+$/.test(a.preview.trim())
    ? a.preview.trim()
    : undefined;

/** The whole sentence, as a notice or a screen reader says it. */
export const sentence = (a: Asking): string => {
  const { wants, what } = asked(a);
  const at = addressOf(a);
  return `${a.agent} ${wants} ${what}${at ? ` at ${at}` : ""}`;
};

/** What a yes covers, for whoever's deciding: this once, in this conversation, for its routine, or always. */
export function reach(
  answer: "once" | "thread" | "origin" | "always",
  a: Asking,
  computer = "this computer",
): string {
  const { verb, what } = asked(a);
  const doing = ({
    terminal: `run commands on ${computer}`,
    jobs: `start jobs on ${computer}`,
    writes: `change files on ${computer}`,
    publish: `publish apps from ${computer}`,
  } as Record<string, string>)[a.work] ?? `use ${a.work} on ${computer}`;
  if (answer === "once") return `${a.agent} may ${verb} ${what}, this once.`;
  if (answer === "origin") {
    return `${a.agent} may ${doing} without asking again, whenever “${a.origin?.name}” runs, ` +
      "until it's changed. It won't cover anything you ask it yourself.";
  }
  const where = answer === "thread" ? "in this conversation" : "in any conversation";
  return `${a.agent} may ${doing} without asking again, ${where}.`;
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
