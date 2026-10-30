/**
 * "Try it": what a key can do, as curl commands to paste in a terminal.
 * Sending a message when it may (`chat.send`), else its first Action; its
 * first query; and following what happens. With the secret when it's just
 * been made (shown once), else a variable to put it in.
 */
import type { CodePart } from "../../../../../hosts/web/mod.ts";

export type Allowed = { actions: string[]; queries: string[]; views?: string[] };

export type Snippet = { title: string; code: CodePart[]; text: string };

/** The variable a key goes in, when the snippet doesn't carry it. */
export const VARIABLE = "COPILOTZ_KEY";

/** Quoted for a POSIX shell, in single quotes. */
const quoted = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`;

/** What an Action is sent, to try it: a message for chat, nothing for the rest. */
const sample = (action: string) => action === "chat.send" ? { text: "Hello from my code" } : {};

export function snippets(origin: string, allowed: Allowed, secret?: string): Snippet[] {
  const key = secret ?? `$${VARIABLE}`;
  const auth = `-H "Authorization: Bearer ${key}"`;
  const made: { title: string; lines: string[] }[] = [];
  const action = allowed.actions.includes("chat.send") ? "chat.send" : allowed.actions[0];
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
  const query = allowed.queries[0];
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

/** What a key does, in a few words: a preset's title when it's exactly one. */
export function summary(
  allowed: Allowed,
  presets: Record<string, { title: string; actions?: string[]; queries?: string[] } | null>,
): string {
  const same = (a: string[] = [], b: string[] = []) =>
    a.length === b.length && a.every((name) => b.includes(name));
  const preset = Object.values(presets).find((p) =>
    p && same(p.actions, allowed.actions) && same(p.queries, allowed.queries)
  );
  if (preset) return preset.title;
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return [
    allowed.actions.length ? count(allowed.actions.length, "Action") : "",
    allowed.queries.length
      ? count(allowed.queries.length, "query").replace("querys", "queries")
      : "",
    allowed.views?.length ? count(allowed.views.length, "View") : "",
  ].filter(Boolean).join(", ");
}
