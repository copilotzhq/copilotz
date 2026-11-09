/**
 * A plugin's reference page, from its declaration: what it keeps, what it
 * lets callers do, where it shows, what it needs and what it requires, in
 * the docs' voice. Nothing here reads code: the page says what the
 * declaration says, so it's as right as the plugin is.
 */
import type {
  ActionDeclaration,
  Admission,
  CallerKind,
  Callers,
  Declaration,
  Place,
} from "../../runtime/describe.ts";

export type PageOptions = {
  /** Where it's imported from today, and as what. */
  module?: string;
  export?: string;
  /** Its front ends, by name (`boards-web`). */
  frontEnds?: string[];
  /** What the page describes, for a plugin a function makes. */
  example?: string;
  /** The plugins with pages of their own: those are links. */
  pages?: Set<string>;
};

const code = (text: string) => `\`${text}\``;
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
/** A text's first sentence, ending as one does. */
const sentence = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  const one = (flat.match(/^.*?[.!?](?=\s+[A-Z(`*]|$)/)?.[0] ?? flat).trim();
  return one && !/[.!?:]$/.test(one) ? `${one}.` : one;
};
const list = (items: string[], and = "and") =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${and} ${items.at(-1)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The callers a page shows, in order, as columns. */
const COLUMNS: [CallerKind, string][] = [
  ["person", "Person"],
  ["agent", "Agent"],
  ["contact", "Contact"],
  ["anonymous", "Anyone"],
  ["key", "Key"],
  ["routine", "Routine"],
  ["maintenance", "Maintenance"],
];

const said: Record<Admission, string> = { yes: "yes", no: "no", some: "depends" };

const link = (name: string, pages?: Set<string>) =>
  pages?.has(name) ? `[${code(name)}](${name}.md)` : code(name);

function table(head: string[], rows: string[][]): string {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function keeps(d: Declaration): string[] {
  const out = ["## What it keeps", ""];
  if (!d.keeps.length && !d.indexes.length && !d.shared.length) {
    return [...out, "It keeps nothing of its own."];
  }
  if (d.keeps.length) {
    const recorded = d.keeps.filter((c) => c.recorded).length;
    const lead = recorded === d.keeps.length
      ? d.keeps.length === 1
        ? ", on the record: every change to it is an event"
        : ", each on the record: every change to one is an event"
      : recorded
      ? `, ${recorded} of them on the record`
      : "";
    out.push(`It keeps ${plural(d.keeps.length, "collection")}${lead}.`, "");
    out.push(table(
      ["Collection", "Kept as", "Fields"],
      d.keeps.map((c) => [
        code(c.name),
        c.kind === "live"
          ? "in memory, gone on restart"
          : c.kind === "records"
          ? "records, appended and never changed"
          : "documents",
        [
          c.fields.map(code).join(", ") || "none named",
          c.private.length ? `private: ${c.private.map(code).join(", ")}` : "",
          c.vectors.length ? `vectors: ${c.vectors.map(code).join(", ")}` : "",
        ].filter(Boolean).join("; "),
      ]),
    ));
    out.push("");
  }
  if (d.shared.length) {
    const names = d.shared.map((s) => code(s.collection));
    out.push(
      `The access rules cover ${
        list(names)
      }: each document is in a space, and only those who reach the space reach it.`,
      "",
    );
  }
  const queries = d.keeps.flatMap((c) => c.queries.map((q) => ({ ...q, of: c.name })));
  if (queries.length) {
    out.push(
      `Its named queries read for callers, as the rules let them:`,
      "",
      table(
        ["Query", "Who outside runs it"],
        queries.map((
          q,
        ) => [code(`${q.of}.${q.name}`), q.internal ? "the app's code" : who(q.callers!)]),
      ),
      "",
    );
  }
  if (d.indexes.length) {
    out.push(
      `It adds indexes to ${list(d.indexes.map((i) => code(i.collection)))}, another plugin's.`,
      "",
    );
  }
  return out;
}

/** Who a set of callers lets in, in words. */
function who(callers: Callers): string {
  const names: Record<CallerKind, string> = {
    person: "people",
    agent: "agents for a person",
    contact: "contacts",
    anonymous: "anyone",
    key: "keys",
    routine: "routines",
    maintenance: "the maintenance key",
  };
  const yes = COLUMNS.filter(([k]) => callers[k] === "yes").map(([k]) => names[k]);
  const some = COLUMNS.filter(([k]) => callers[k] === "some").map(([k]) => names[k]);
  const parts = [
    yes.length ? list(yes) : "",
    some.length ? `${list(some, "or")}, depending on input` : "",
  ].filter(Boolean);
  return parts.join("; ") || "nobody";
}

/** Who may call how many of its Actions, by kind of caller: "people may call 7; …". */
function lead(outside: ActionDeclaration[], total: number): string {
  const labels: [CallerKind, string][] = [
    ["person", "people"],
    ["agent", "agents"],
    ["contact", "contacts"],
    ["anonymous", "someone signed out"],
  ];
  const groups = new Map<number, string[]>();
  for (const [kind, label] of labels) {
    const n = outside.filter((a) => a.callers?.[kind] !== "no").length;
    groups.set(n, [...groups.get(n) ?? [], label]);
  }
  const parts = [...groups].sort(([a], [b]) => b - a).map(([n, who]) =>
    `${list(who)} may call ${n === 0 ? "none" : n === total && total > 1 ? `all ${n}` : n}`
  );
  return `Of its ${plural(total, "Action")}, ${parts.join("; ")}.`;
}

function callers(d: Declaration): string[] {
  const out = ["## What it lets callers do", ""];
  const outside = d.actions.filter((a) => !a.internal);
  const internal = d.actions.filter((a) => a.internal);
  if (!d.actions.length && !d.routes.length && !d.tools.length) {
    return [...out, "Nobody calls it: it has no Actions, tools or routes."];
  }
  if (d.actions.length && !outside.length) {
    out.push(
      `Only the app's own code calls its ${plural(internal.length, "Action")}, ` +
        `${list(internal.map((a) => code(a.name)))}: its plugins, its schedules and the system. ` +
        "Nobody outside does.",
      "",
    );
  } else if (outside.length) {
    out.push(lead(outside, d.actions.length), "");
  }
  if (outside.length) {
    // A routine's column where it isn't its person's; the maintenance key's where it calls any.
    const columns = COLUMNS.filter(([kind]) =>
      kind === "routine"
        ? outside.some((a) => a.callers?.routine !== a.callers?.person)
        : kind !== "maintenance" || outside.some((a) => a.callers?.maintenance !== "no")
    );
    out.push(table(
      ["Action", ...columns.map(([, label]) => label), "What it does"],
      outside.map((a: ActionDeclaration) => [
        code(a.name),
        ...columns.map(([kind]) => said[a.callers![kind]]),
        sentence(a.summary),
      ]),
    ));
    out.push("");
    const notes = [
      "An agent works for a person, and calls what both may. A key calls only what its scope names.",
      columns.some(([kind]) => kind === "routine")
        ? "A routine is work done for a person, which they set going."
        : "",
      outside.some((a) => Object.values(a.callers!).includes("some"))
        ? `"depends": its \`allow\` reads the input to decide.`
        : "",
    ].filter(Boolean);
    out.push(notes.join(" "), "");
  }
  if (internal.length && outside.length) {
    out.push(
      `Only the app's own code calls ${
        list(internal.map((a) => code(a.name)))
      }: its plugins, its schedules and the system.`,
      "",
    );
  }
  if (d.tools.length) {
    const called = new Map(d.actions.filter((a) => a.tool).map((a) => [a.tool!, a.name]));
    out.push(
      `Agents act through its ${
        d.tools.length === 1 ? "tool" : plural(d.tools.length, "tool")
      }, as whoever they work for:`,
      "",
      table(
        ["Tool", "What it does", "Calls"],
        d.tools.map((t) => [
          code(t.name),
          sentence(t.summary),
          called.has(t.name) ? code(called.get(t.name)!) : "",
        ]),
      ),
      "",
    );
  }
  const routes = d.routes.filter((r) => !r.removes);
  if (routes.length) {
    out.push(
      `It answers ${plural(routes.length, "route")} over HTTP:`,
      "",
      table(["Method", "Path"], routes.map((r) => [r.method, code(r.path)])),
      "",
    );
  }
  const powers = [
    d.powers.includes("who") ? "says who a request is (`who`)" : "",
    d.powers.includes("guard") ? "adds rules every read and write keeps to (`guard`)" : "",
    d.powers.includes("labels") ? "carries what a job read to what it writes (`labels`)" : "",
    d.powers.includes("workers") ? "lets programs outside the app connect as workers" : "",
  ].filter(Boolean);
  if (powers.length) out.push(`It also ${list(powers)}.`, "");
  const ports = Object.entries(d.adapters);
  if (ports.length) {
    out.push(
      `Other plugins call it through its adapters: ${
        ports.map(([port, names]) => `${code(port)} (${names.map(code).join(", ")})`).join(", ")
      }.`,
      "",
    );
  }
  return out;
}

const PLACES: [Place, string][] = [
  ["web", "On the web"],
  ["terminal", "In the terminal"],
  ["prompt", "To the model"],
  ["other", "Elsewhere"],
];

function shows(d: Declaration, options: PageOptions): string[] {
  const out = ["## Where it shows", ""];
  const views = d.views.filter((v) => !v.removes);
  const removed = d.views.filter((v) => v.removes);
  const fronts = (options.frontEnds ?? []).map((name) => link(name, options.pages));
  if (!views.length && !d.tools.length) {
    out.push(
      fronts.length
        ? `It has no Views of its own: its front ends show it, ${list(fronts)}.`
        : "It has no Views: it shows nowhere on its own.",
    );
  } else {
    const places = PLACES.filter(([place]) => views.some((v) => v.place === place));
    out.push(
      places.length
        ? `Its Views show ${list(places.map(([, label]) => label.toLowerCase()))}.`
        : "It shows to the model through its tools.",
      "",
    );
    for (const [place, label] of places) {
      const names = views.filter((v) => v.place === place).map((v) => code(v.name));
      out.push(`- **${label}:** ${names.join(", ")}.`);
    }
    if (d.tools.length) {
      out.push(`- **Agents' tools:** ${d.tools.map((t) => code(t.name)).join(", ")}.`);
    }
    if (fronts.length) out.push(`- **Front ends:** ${list(fronts)}.`);
  }
  // What it adds to other plugins' resource kinds: a tab, a palette's group, a name source.
  const fills = Object.entries(d.resources.provides).filter(([kind, entries]) =>
    !["tools", "shared"].includes(kind) && !d.settings.some((s) => s.kind === kind) &&
    Object.keys(entries).length
  );
  if (fills.length) {
    if (!views.length && !d.tools.length && !fronts.length) out.push("");
    out.push(
      `- **What it adds to resources:** ${
        fills.map(([kind, entries]) =>
          `${code(kind)} (${Object.keys(entries).map(code).join(", ")})`
        )
          .join(", ")
      }.`,
    );
  }
  if (removed.length) {
    out.push("", `It removes another plugin's ${list(removed.map((v) => code(v.name)))}.`);
  }
  out.push("");
  return out;
}

function needs(d: Declaration): string[] {
  const out = ["## What it needs", ""];
  const settings = d.needs;
  const reads = d.resources.reads.map((r) => r.kind).filter((kind) =>
    !d.settings.some((s) => s.kind === kind) && !settings.some((n) => n.path === kind)
  );
  if (!settings.length && !reads.length && !d.check?.refuses) {
    return [...out, "Nothing to set: it works as it comes.", ""];
  }
  if (!settings.length && !d.check?.refuses) {
    return [
      ...out,
      `Nothing to set. It reads ${
        list(reads.map(code))
      }, resource kinds the app and other plugins fill.`,
      "",
    ];
  }
  if (settings.length) {
    const required = settings.filter((n) => n.required).length;
    const secrets = settings.filter((n) => n.kind === "secret").length;
    out.push(
      `You set it in ${list(sortedKinds(d).map((k) => code(`resources.${k}`)))}` +
        (required ? `: ${plural(required, "setting is", "settings are")} required` : "") +
        (secrets
          ? `, and ${plural(secrets, "is a secret", "are secrets")}, kept out of your code`
          : "") +
        ".",
      "",
      table(
        ["Setting", "Type", "Required", "What it is"],
        settings.map((n) => [
          code(n.path),
          n.type ? code(n.type) : "",
          n.required ? "yes" : "no",
          `${n.kind === "secret" ? "Secret. " : ""}${sentence(n.summary)}`,
        ]),
      ),
      "",
    );
  }
  if (d.check?.refuses) {
    out.push(
      `Until it's set, the runtime doesn't start. With nothing set, its check says: "${
        d.check.refuses.replace(/\.?$/, ".")
      }"`,
      "",
    );
  }
  if (reads.length) {
    out.push(
      `It also reads ${list(reads.map(code))}, resource kinds the app and other plugins fill.`,
      "",
    );
  }
  return out;
}

const sortedKinds = (d: Declaration) =>
  [...new Set(d.needs.map((n) => n.path.split(".")[0]))].sort();

function requires(d: Declaration, options: PageOptions): string[] {
  const out = ["## What it requires", ""];
  const names = d.requires.map((name) => link(name, options.pages));
  out.push(
    names.length
      ? `The runtime doesn't start without ${list(names)}: add ${
        names.length === 1 ? "it" : "them"
      } too.`
      : "It builds on no other plugin.",
    "",
  );
  if (d.layer === "package" && d.package) {
    const at = d.package.version ? `${d.package.name}@${d.package.version}` : d.package.name;
    out.push(
      `It ships in a package of its own, ${code(at)}` +
        (d.runtime ? `, for \`copilotz\` ${code(d.runtime)}` : "") +
        ": install it beside `copilotz`.",
      "",
    );
  } else if (d.package) {
    const at = d.package.version ? `${d.package.name}@${d.package.version}` : d.package.name;
    const same = d.runtime && d.package.version === d.runtime &&
      ["copilotz", "@copilotz/copilotz"].includes(d.package.name);
    out.push(
      same
        ? `It ships with ${code(at)}.`
        : `It ships in ${code(at)}` + (d.runtime ? `, for \`copilotz\` ${code(d.runtime)}` : "") +
          ".",
      "",
    );
  }
  return out;
}

function onItsOwn(d: Declaration): string[] {
  if (!d.processors.length && !d.schedules.length && !d.emits.length) return [];
  const out = ["## What it does on its own", ""];
  out.push("Some of its work starts without a caller: an event, or the time.", "");
  for (const p of d.processors) {
    out.push(`- ${code(p.name)} runs on ${list(p.on.map(code), "or")}.`);
  }
  for (const s of d.schedules.filter((s) => !s.removes)) {
    const what = s.call ? `calls ${code(s.call)}` : "changes another plugin's schedule";
    out.push(`- ${code(s.name)} ${what}, ${s.when}.${s.summary ? ` ${sentence(s.summary)}` : ""}`);
  }
  for (const e of d.emits) {
    out.push(`- It emits ${code(e.type)}.${e.summary ? ` ${sentence(e.summary)}` : ""}`);
  }
  out.push("");
  return out;
}

function listed(d: Declaration): string[] {
  const { problems, warnings } = d.listing;
  if (!problems.length && !warnings.length) {
    return ["## Listing", "", "It keeps every listing rule.", ""];
  }
  return [
    "## Listing",
    "",
    problems.length
      ? `It breaks ${plural(problems.length, "listing rule")} as it is:`
      : "It keeps every listing rule. Before adding it, know this:",
    "",
    ...problems.map((p) => `- ${p}`),
    ...(problems.length && warnings.length ? ["", "And before adding it, know this:", ""] : []),
    ...warnings.map((w) => `- ${w}`),
    "",
  ];
}

/** The page, as Markdown. */
export function page(d: Declaration, options: PageOptions = {}): string {
  const summary = d.summary ?? "";
  const lines = [
    "---",
    `title: ${JSON.stringify(d.name)}`,
    `description: ${JSON.stringify(summary)}`,
    "---",
    "",
    "<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->",
    "",
    `# ${d.name}`,
    "",
  ];
  if (summary) lines.push(summary, "");
  if (options.example) lines.push(options.example, "");
  if (options.module && options.export) {
    const name = options.export.split(".")[0];
    lines.push(
      "```ts",
      `import { ${name} } from ${JSON.stringify(options.module)};`,
      "```",
      "",
    );
  }
  lines.push(
    ...keeps(d),
    ...callers(d),
    ...shows(d, options),
    ...needs(d),
    ...requires(d, options),
    ...onItsOwn(d),
    ...listed(d),
  );
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
