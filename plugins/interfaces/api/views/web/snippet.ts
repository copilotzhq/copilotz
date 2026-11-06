/**
 * "Try it": what a key can do, as curl commands to paste in a terminal.
 * Sending a message when it may (`chat.send`), else its first Action; its
 * first query; and following what happens. With the secret when it's just
 * been made (shown once), else a variable to put it in. And what a key may
 * use, in a few words.
 */
import type { Scope } from "../../../../../runtime/mod.ts";
import type { CodePart } from "../../../../../hosts/web/mod.ts";

export type Snippet = { title: string; code: CodePart[]; text: string };

/** The variable a key goes in, when the snippet doesn't carry it. */
export const VARIABLE = "COPILOTZ_KEY";

/** The kinds of names a scope lists, in the order they're said. */
export const KINDS = ["call", "query", "view", "read", "write"] as const;

/** Quoted for a POSIX shell, in single quotes. */
const quoted = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`;

/** What an Action is sent, to try it: a message for chat, nothing for the rest. */
const sample = (action: string) => action === "chat.send" ? { text: "Hello from my code" } : {};

export function snippets(origin: string, scope: Scope, secret?: string): Snippet[] {
  const key = secret ?? `$${VARIABLE}`;
  const auth = `-H "Authorization: Bearer ${key}"`;
  const made: { title: string; lines: string[] }[] = [];
  const calls = scope.call ?? [];
  const action = calls.includes("chat.send") ? "chat.send" : calls[0];
  if (action) {
    made.push({
      title: action === "chat.send" ? "Send a message" : `Call ${action}`,
      lines: [
        `curl -X POST ${origin}/api/actions/${action} \\`,
        `  ${auth} \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d ${quoted(JSON.stringify(sample(action)))}`,
      ],
    });
  }
  const query = scope.query?.[0];
  if (query) {
    made.push({
      title: `Run ${query}`,
      lines: [`curl -X POST ${origin}/api/queries/${query} \\`, `  ${auth} -d '{}'`],
    });
  }
  made.push({
    title: action === "chat.send" ? "Follow the replies" : "Follow what happens",
    lines: [`curl -N ${origin}/api/events \\`, `  ${auth}`],
  });
  return made.map(({ title, lines }) => {
    const text = lines.join("\n");
    // The key stands out, so it's seen for what it is.
    const code: CodePart[] = text.split(key).flatMap((piece, i) =>
      i ? [{ text: key, tone: "accent" as const }, { text: piece }] : [{ text: piece }]
    );
    return { title, code, text };
  });
}

/** Whether two scopes list the same names, in any order. */
export function sameScope(a: Scope, b: Scope): boolean {
  const same = (x: string[] = [], y: string[] = []) =>
    x.length === y.length && x.every((name) => y.includes(name));
  return KINDS.every((kind) => same(a[kind], b[kind]));
}

/** Every name a scope lists, once each, in the order its kinds are said. */
export const namesIn = (scope: Scope): string[] => [
  ...new Set(KINDS.flatMap((kind) => scope[kind] ?? [])),
];

/** What a key may use, in a few words: a preset's title when it's exactly one. */
export function summary(
  scope: Scope,
  presets: Record<string, { title: string; scope: Scope } | null>,
): string {
  const preset = Object.values(presets).find((p) => p?.scope && sameScope(p.scope, scope));
  if (preset) return preset.title;
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const collections = new Set([...scope.read ?? [], ...scope.write ?? []]).size;
  return [
    scope.call?.length ? count(scope.call.length, "Action") : "",
    scope.query?.length ? count(scope.query.length, "query", "queries") : "",
    scope.view?.length ? count(scope.view.length, "View") : "",
    collections ? count(collections, "collection") : "",
  ].filter(Boolean).join(", ");
}
