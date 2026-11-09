/**
 * What a plugin's code shows that its data doesn't: the resource kinds it
 * reads, the settings types it exports, and the sentence it opens with. Found
 * by reading its files, as Deno sees them (`deno info` for what imports what,
 * `deno doc` for types and where each export is declared).
 *
 * A plugin's files are those its declaration imports, directly or not,
 * inside its folder: the nearest folder laid out by primitive (`actions/`,
 * `views/`…) or with a `contract.ts`, as testing/boundaries.test.ts finds
 * it. Another plugin's contract is outside it, so what that reads isn't
 * counted. Where one file declares two plugins (`email` and `emailSignIn`),
 * each counts only what its own declaration uses.
 *
 * - **Reads:** `resources.<kind>` (or `?.`, or `["<kind>"]`) in its code,
 *   comments left out; code only, never what's imported for its types.
 * - **Settings:** each `<Name>Settings` type its files export, with its
 *   fields (or its entries' fields, for a map: `Record<string, DeclaredNumber>`),
 *   tied to a resource kind by how its code reads it
 *   (`resources.google … as GoogleSettings`), what its doc says (the `google`
 *   resource), or its name (`MaintenanceSettings`, `maintenance`).
 */
import { posix, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SettingDeclaration, SettingField } from "../../runtime/describe.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

/**
 * Paths here are posix on every OS (`D:/app/x.ts` on Windows): what a file
 * imports is joined to it with `posix`, and a file URL's path loses its `\`.
 */
export const toPosix = (path: string): string => path.replaceAll("\\", "/");
const pathOf = (url: string) => toPosix(fileURLToPath(url));
const { dirname, join } = posix;
/** What `spec` imports from `file`: a path, posix, absolute or relative as `file` is. */
const resolved = (file: string, spec: string) =>
  posix.normalize(join(dirname(toPosix(file)), spec));

const run = async (args: string[]): Promise<Json> => {
  const output = await new Deno.Command(Deno.execPath(), {
    args,
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!output.success) throw new Error(`deno ${args.join(" ")} failed`);
  return JSON.parse(new TextDecoder().decode(output.stdout));
};

const docs = new Map<string, Promise<Json>>();
/** `deno doc --json` of a file, once. */
const docOf = (file: string): Promise<Json> => {
  if (!docs.has(file)) docs.set(file, run(["doc", "--json", file]));
  return docs.get(file)!;
};

/** Every symbol a file exports (its own and re-exported), with where each is declared. */
async function symbolsOf(file: string): Promise<Map<string, Json>> {
  const doc = await docOf(file);
  const symbols = new Map<string, Json>();
  for (const node of Object.values(doc.nodes ?? {}) as Json[]) {
    for (const symbol of node.symbols ?? []) symbols.set(symbol.name, symbol);
  }
  return symbols;
}

/** What each local file imports: for its code, and for its types alone. */
type Graph = Map<string, { code: string[]; types: string[] }>;

const graphs = new Map<string, Promise<Graph>>();
/** The local files `file` imports, directly or not, from `deno info`. */
const graphOf = (file: string): Promise<Graph> => {
  if (!graphs.has(file)) {
    graphs.set(
      file,
      run(["info", "--json", file]).then((info: Json) => {
        const graph: Graph = new Map();
        const local = (s: unknown): s is string => typeof s === "string" && s.startsWith("file:");
        for (const module of info.modules ?? []) {
          if (!local(module.specifier)) continue;
          const deps = module.dependencies ?? [];
          graph.set(pathOf(module.specifier), {
            code: deps.map((d: Json) => d.code?.specifier).filter(local).map(pathOf),
            types: deps.map((d: Json) => d.type?.specifier).filter(local).map(pathOf),
          });
        }
        return graph;
      }),
    );
  }
  return graphs.get(file)!;
};

const PRIMITIVES = [
  "actions",
  "adapters",
  "collections",
  "events",
  "processors",
  "resources",
  "routes",
  "views",
];

const isDir = (path: string) => {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
};

/** The folder a plugin lives in: the nearest with a contract.ts or a folder by primitive. */
export function folderOf(home: string): string {
  for (let dir = dirname(home), up = 0; up < 3; dir = dirname(dir), up++) {
    let names: string[] = [];
    try {
      names = [...Deno.readDirSync(dir)].map((entry) => entry.name);
    } catch {
      break;
    }
    if (
      names.includes("contract.ts") ||
      names.some((n) => PRIMITIVES.includes(n) && isDir(join(dir, n)))
    ) {
      return dir;
    }
  }
  return dirname(home);
}

/** What `starts` import, directly or not, inside `folder`: for their code and their types. */
function reach(graph: Graph, starts: string[], folder: string): string[] {
  const inside = (file: string) => file.startsWith(folder + "/");
  const seen = new Set<string>(starts);
  const queue = [...starts];
  while (queue.length) {
    const deps = graph.get(queue.shift()!);
    for (const next of [...deps?.code ?? [], ...deps?.types ?? []]) {
      if (!seen.has(next) && inside(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen].sort();
}

/** Source without its comments (strings that look like them are rare enough here). */
export const uncommented = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** Code without its strings' contents: names in them (`"email"`) aren't what it uses. */
const unquoted = (code: string): string =>
  code.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');

/** The resource kinds code reads: `resources.<kind>`, `resources?.<kind>`, `resources["<kind>"]`. */
export function readsIn(source: string): string[] {
  const code = uncommented(source);
  const kinds = [
    ...code.matchAll(/\bresources\s*\??\.\s*([A-Za-z_$][\w$]*)/g),
    ...code.matchAll(/\bresources\s*\??\.?\s*\[\s*["'`]([A-Za-z_$][\w$]*)["'`]\s*\]/g),
  ].map(([, kind]) => kind);
  return [...new Set(kinds)].sort();
}

/** How code reads a kind as a settings type: `resources.google ?? {}) as GoogleSettings`. */
const castsIn = (source: string): [type: string, kind: string][] =>
  [
    ...uncommented(source).matchAll(
      /\bresources\s*\??\.\s*([A-Za-z_$][\w$]*)[^;\n]{0,60}?\bas\s+(?:Partial<\s*)?([A-Za-z_$][\w$]*Settings)\b/g,
    ),
  ].map(([, kind, type]) => [type, kind]);

/** The first sentence of a doc comment: what the plugin is, in its own words. */
export function firstSentence(doc: string): string {
  const paragraph = doc.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  let sentence = (paragraph.match(/^.*?[.!?](?=\s+[A-Z(`*]|$)/)?.[0] ?? paragraph)
    .replace(/\*\*/g, "").trim();
  // A long one that lists what it has after a colon: what comes before it, if that says enough.
  if (sentence.length > 200) {
    const colon = [...sentence.matchAll(/: /g)].map((m) => m.index!).find((at) =>
      at >= 25 && at < 200
    );
    if (colon) sentence = sentence.slice(0, colon);
  }
  return sentence.replace(/[:;,]$/, "").replace(/([^.!?])$/, "$1.");
}

/** The text of a `/** … *\/` comment. */
const docText = (comment: string) =>
  comment.replace(/^\/\*\*/, "").replace(/\*\/$/, "").split("\n").map((line) =>
    line.replace(/^\s*\* ?/, "")
  ).join("\n").trim();

/** The doc comment right above an export, or else the file's first. */
export function summaryIn(source: string, name?: string): string | undefined {
  if (name) {
    const at = source.search(new RegExp(`export\\s+(const|function|let)\\s+${name}\\b`));
    if (at > 0) {
      const before = source.slice(0, at).trimEnd();
      const comment = before.match(/\/\*\*(?:(?!\*\/)[\s\S])*\*\/$/)?.[0];
      // One that points at the file's own doc ("see above") isn't the summary.
      if (comment && !/\bsee above\b/i.test(comment)) return firstSentence(docText(comment));
    }
  }
  const top = source.match(/^\s*\/\*\*[\s\S]*?\*\//)?.[0];
  return top ? firstSentence(docText(top.trim())) : undefined;
}

// ---------------------------------------------------------------------------
// What a declaration uses, symbol by symbol

/** Where a plugin is declared by name: `definePlugin({ name: "<name>"`. */
const declaring = (name: string) =>
  new RegExp(`(definePlugin\\(\\{|:\\s*Plugin\\s*=\\s*\\{)\\s*name:\\s*"${name}"`);

const DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/;

/** A file's top-level declarations, by name, with their text (as deno fmt lays them out). */
function declarationsIn(source: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | undefined;
  let text: string[] = [];
  const close = () => {
    if (name) out.set(name, text.join("\n"));
    name = undefined;
    text = [];
  };
  for (const line of source.split("\n")) {
    if (/^\S/.test(line) && !/^[})\]]/.test(line)) {
      close();
      name = line.match(DECLARATION)?.[1];
    }
    if (name) text.push(line);
  }
  close();
  return out;
}

/** Something a file names from another: its file, and its name there ("default", "*"). */
type Named = { file: string; name: string };

/** The bindings in `{ a, b as c, type d }`, as [their name there, the name here]. */
const bindings = (list: string): [string, string][] =>
  list.split(",").map((part) => part.trim()).filter((part) => part && !part.startsWith("type "))
    .map((part) => {
      const [there, here] = part.split(/\s+as\s+/).map((w) => w.trim());
      return [there, here ?? there];
    });

const local = (spec: string) => spec.startsWith("./") || spec.startsWith("../");

/** A file's imports of code, by the name each binds here. */
function importsIn(source: string, file: string): Map<string, Named> {
  const out = new Map<string, Named>();
  const at = /^import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
  for (const [, type, what, spec] of source.matchAll(at)) {
    if (type || !local(spec)) continue;
    const path = resolved(file, spec);
    for (const [there, here] of bindings(what.match(/\{([\s\S]*)\}/)?.[1] ?? "")) {
      out.set(here, { file: path, name: there });
    }
    const head = what.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim();
    const space = head.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)?.[1];
    if (space) out.set(space, { file: path, name: "*" });
    const fallback = head.replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, "").trim();
    if (fallback) out.set(fallback, { file: path, name: "default" });
  }
  return out;
}

/** What a file exports by name from others (`export { a } from`), and the files it exports all of. */
function reexportsIn(source: string, file: string) {
  const named = new Map<string, Named>();
  const stars: string[] = [];
  const at = /^export\s+(type\s+)?(\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/gm;
  for (const [, type, what, spec] of source.matchAll(at)) {
    if (type || !local(spec)) continue;
    const path = resolved(file, spec);
    if (what === "*") {
      stars.push(path);
      continue;
    }
    for (const [there, here] of bindings(what.slice(1, -1))) {
      named.set(here, { file: path, name: there });
    }
  }
  // `export { a as b }`, of its own.
  const aliases = new Map<string, string>();
  for (const [, list] of source.matchAll(/^export\s+\{([^}]*)\}\s*;/gm)) {
    for (const [there, here] of bindings(list)) aliases.set(here, there);
  }
  return { named, stars, aliases };
}

/**
 * What code in a file uses, from the declarations named (`names`; `*` for
 * all of the file) or the plugin it declares by name: their text and the
 * local declarations they name, and what they name from other files.
 */
export function usedIn(
  source: string,
  file: string,
  start: { names: string[] } | { plugin: string },
): { text: string; wants: Named[]; whole: boolean } {
  const imports = importsIn(source, file);
  const whole = () => ({ text: source, wants: [...imports.values()], whole: true });
  const declarations = declarationsIn(source);
  const texts = new Map<string, string>();
  const wants: Named[] = [];
  if ("plugin" in start) {
    const found = [...declarations].find(([, text]) => declaring(start.plugin).test(text));
    if (!found) return whole();
    texts.set(...found);
  } else {
    if (start.names.includes("*") || start.names.includes("default")) return whole();
    const { named, stars, aliases } = reexportsIn(source, file);
    for (const wanted of start.names) {
      const name = aliases.get(wanted) ?? wanted;
      if (declarations.has(name)) texts.set(name, declarations.get(name)!);
      else if (named.has(name)) wants.push(named.get(name)!);
      else if (stars.length) wants.push(...stars.map((star) => ({ file: star, name })));
      else return whole();
    }
  }
  const queue = [...texts.values()];
  while (queue.length) {
    for (const [word] of unquoted(uncommented(queue.shift()!)).matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (imports.has(word)) wants.push(imports.get(word)!);
      const text = declarations.get(word);
      if (text !== undefined && !texts.has(word)) {
        texts.set(word, text);
        queue.push(text);
      }
    }
  }
  return { text: [...texts.values()].join("\n"), wants, whole: false };
}

/**
 * What a plugin's code runs: from its declaration in `home`, every
 * declaration it names, followed into the files it imports them from,
 * inside `folder`. Their text, and the files.
 */
async function runs(home: string, folder: string, plugin: string) {
  const done = new Map<string, Set<string> | true>();
  const texts: string[] = [];
  const queue: { file: string; start: { names: string[] } | { plugin: string } }[] = [
    { file: home, start: { plugin } },
  ];
  while (queue.length) {
    const { file, start } = queue.shift()!;
    if (file !== home && !file.startsWith(folder + "/")) continue;
    const had = done.get(file);
    if (had === true) continue;
    let wanted = start;
    if ("names" in start && had) {
      const fresh = start.names.filter((name) => !had.has(name));
      if (!fresh.length) continue;
      wanted = { names: fresh };
    }
    let source: string;
    try {
      source = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    const used = usedIn(source, file, wanted);
    if (used.whole) done.set(file, true);
    else {
      const names = had instanceof Set ? had : new Set<string>();
      for (const name of "names" in wanted ? wanted.names : [`plugin:${plugin}`]) names.add(name);
      done.set(file, names);
    }
    texts.push(used.text);
    for (const want of used.wants) queue.push({ file: want.file, start: { names: [want.name] } });
  }
  return { text: texts.join("\n"), files: [...done.keys()].sort() };
}

// ---------------------------------------------------------------------------
// Settings types

/** A TypeScript type, from `deno doc`, as text. */
export function typeText(t: Json): string {
  if (!t) return "unknown";
  switch (t.kind) {
    case "keyword":
      return t.value;
    case "literal": {
      const v = t.value ?? {};
      if (v.kind === "string") return JSON.stringify(v.string);
      if (v.kind === "number") return String(v.number);
      if (v.kind === "boolean") return String(v.boolean);
      return t.repr ?? "literal";
    }
    case "typeRef": {
      const params = t.value?.typeParams?.map(typeText);
      return `${t.value?.typeName ?? t.repr}${params?.length ? `<${params.join(", ")}>` : ""}`;
    }
    case "union":
      return t.value.map(typeText).join(" | ");
    case "intersection":
      return t.value.map(typeText).join(" & ");
    case "array":
      return `${typeText(t.value)}[]`;
    case "parenthesized":
      return `(${typeText(t.value)})`;
    case "typeLiteral":
      return "object";
    case "fnOrConstructor":
      return "function";
    case "tuple":
      return `[${t.value.map(typeText).join(", ")}]`;
    default:
      return t.repr || t.kind || "unknown";
  }
}

/** A field that holds a credential, by its name. */
export const SECRET = /(key|token|secret|password)$/i;

/** A type's fields: an object's, an intersection's together; a map's entries' (`each`). */
async function fieldsOf(
  t: Json,
  file: string,
  depth = 0,
): Promise<{ fields: SettingField[]; each?: boolean }> {
  if (!t || depth > 3) return { fields: [] };
  if (t.kind === "typeLiteral") {
    const fields: SettingField[] = [];
    let previous: { line: number; doc?: string } | undefined;
    for (const p of t.value?.properties ?? []) {
      const line = p.location?.line ?? 0;
      // A comment over a group of fields speaks for each of them.
      const doc = p.jsDoc?.doc ??
        (previous && line === previous.line + 1 ? previous.doc : undefined);
      fields.push({
        name: p.name,
        type: typeText(p.tsType),
        optional: !!p.optional,
        ...(doc ? { doc: doc.replace(/\s+/g, " ").trim() } : {}),
        secret: SECRET.test(p.name),
      });
      previous = { line, doc };
    }
    return { fields };
  }
  if (t.kind === "intersection" || t.kind === "union") {
    const parts = await Promise.all(t.value.map((part: Json) => fieldsOf(part, file, depth + 1)));
    const seen = new Set<string>();
    const fields = parts.flatMap((part) => part.fields).filter((f) =>
      !seen.has(f.name) && seen.add(f.name)
    );
    return { fields, ...(parts.some((part) => part.each) ? { each: true } : {}) };
  }
  if (t.kind === "parenthesized") return fieldsOf(t.value, file, depth + 1);
  if (t.kind === "typeRef") {
    const name = t.value?.typeName;
    const params = t.value?.typeParams ?? [];
    if (name === "Record" && params.length === 2) {
      return { ...(await fieldsOf(params[1], file, depth + 1)), each: true };
    }
    if (name === "Partial" && params.length === 1) {
      const inner = await fieldsOf(params[0], file, depth + 1);
      return { ...inner, fields: inner.fields.map((f) => ({ ...f, optional: true })) };
    }
    const symbol = (await symbolsOf(file)).get(name);
    const declared = symbol?.declarations?.find((d: Json) => d.kind === "typeAlias");
    if (declared) {
      return fieldsOf(declared.def?.tsType, pathOf(declared.location.filename), depth + 1);
    }
  }
  return { fields: [] };
}

/** The kinds a doc says are resources: the `google` resource, `resources.google`. */
const saidIn = (doc: string): string[] =>
  [
    ...doc.matchAll(/\bthe `([A-Za-z_$][\w$]*)`\s+resource/gi),
    ...doc.matchAll(/`resources\.([A-Za-z_$][\w$]*)/g),
  ].map(([, kind]) => kind);

/**
 * The resource kind a settings type is for: how code reads it (a cast), what
 * its doc says, or its name, where its file's doc says that kind is a resource.
 */
function kindOf(
  name: string,
  doc: string,
  fileDoc: string,
  casts: Map<string, string>,
): string | undefined {
  if (casts.has(name)) return casts.get(name);
  const said = saidIn(doc)[0];
  if (said) return said;
  const stem = name.replace(/Settings$/, "");
  const lower = stem.charAt(0).toLowerCase() + stem.slice(1);
  return saidIn(fileDoc).includes(lower) ? lower : undefined;
}

/** The settings types its files export, each with its kind and fields. */
async function settingsIn(
  files: string[],
  code: string,
  reads: string[],
  contract: Set<string>,
): Promise<SettingDeclaration[]> {
  const casts = new Map<string, string>();
  for (const [type, kind] of castsIn(code)) if (!casts.has(type)) casts.set(type, kind);
  const settings: SettingDeclaration[] = [];
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    const names = [...source.matchAll(/export\s+type\s+([A-Za-z_$][\w$]*Settings)\b/g)].map((
      [, name],
    ) => name);
    if (!names.length) continue;
    const symbols = await symbolsOf(file);
    // A settings file's, or a contract's, doc speaks for its types.
    const fileDoc = /\/(settings|contract)\.ts$/.test(file)
      ? source.match(/^\s*\/\*\*[\s\S]*?\*\//)?.[0] ?? ""
      : "";
    for (const name of names) {
      const declared = symbols.get(name)?.declarations?.find((d: Json) => d.kind === "typeAlias");
      if (!declared) continue;
      const doc = (declared.jsDoc?.doc ?? "").replace(/\s+/g, " ").trim();
      const kind = kindOf(name, doc, fileDoc, casts);
      // A type for a kind it doesn't read is another's (a part of one, a model's settings).
      if (!kind || !reads.includes(kind)) continue;
      const typed = await fieldsOf(declared.def?.tsType, file);
      const fields = typed.fields;
      // `resources.openapi.<name>`: one entry per name, each of this type.
      const each = typed.each || new RegExp(`resources\\.${kind}\\.<[\\w-]+>`).test(doc);
      settings.push({
        kind,
        type: name,
        inContract: contract.has(name),
        fields,
        ...(each ? { each } : {}),
        ...(doc ? { doc: firstSentence(doc) } : {}),
      });
    }
  }
  // One per kind: the type named after it, else the first found.
  const byKind = new Map<string, SettingDeclaration>();
  for (const s of settings) {
    const had = byKind.get(s.kind);
    const named = (t?: string) => t?.toLowerCase() === `${s.kind.toLowerCase()}settings`;
    if (!had || (!named(had.type) && named(s.type))) byKind.set(s.kind, s);
  }
  return [...byKind.values()].sort((a, b) => a.kind < b.kind ? -1 : 1);
}

// ---------------------------------------------------------------------------

export type Found = {
  /** The file that declares the plugin, relative to the root scanned, posix (`plugins/x/mod.ts`). */
  home: string;
  /** Its files: those its code runs, as `home` is. */
  files: string[];
  /** The resource kinds its code reads. */
  reads: string[];
  settings: SettingDeclaration[];
  /** What it is, in the first sentence of its doc. */
  summary?: string;
};

/**
 * What a plugin's code shows: `entry` is the module it's exported from,
 * `exportName` the export, `pluginName` its name (to find where it's
 * declared). Its files are said relative to `root` (the working directory).
 */
export async function found(
  entry: string,
  exportName: string,
  pluginName: string,
  root: string = Deno.cwd(),
): Promise<Found> {
  entry = toPosix(entry);
  const exported = await symbolsOf(entry);
  // Where it's declared: the file that names it, else where its export says.
  let home: string | undefined;
  for (const file of (await graphOf(entry)).keys()) {
    if (declaring(pluginName).test(await Deno.readTextFile(file))) {
      home = file;
      break;
    }
  }
  const symbol = exportName === "default" ? undefined : exported.get(exportName);
  const at = symbol?.declarations?.[0]?.location?.filename;
  home ??= at ? pathOf(at) : entry;
  const folder = folderOf(home);
  const code = await runs(home, folder, pluginName);
  const reads = readsIn(code.text);
  // Its contract: what its module exports, and its folder's mod.ts and contract.ts.
  const contract = new Set(exported.keys());
  for (const name of ["mod.ts", "contract.ts"]) {
    const file = join(folder, name);
    try {
      Deno.statSync(file);
      for (const symbol of (await symbolsOf(file)).keys()) contract.add(symbol);
    } catch {
      // No such file.
    }
  }
  // Settings types may sit where only types are imported from (a contract).
  const typed = reach(await graphOf(home), code.files, folder);
  const summary = summaryIn(
    await Deno.readTextFile(home),
    exportName === "default" ? undefined : exportName,
  );
  const under = (file: string) => toPosix(relative(root, file));
  return {
    home: under(home),
    files: code.files.map(under),
    reads,
    settings: await settingsIn(typed, code.text, reads, contract),
    ...(summary ? { summary } : {}),
  };
}

/** A path as a file URL, for `import()`. */
export const urlOf = (path: string) => pathToFileURL(path).href;
