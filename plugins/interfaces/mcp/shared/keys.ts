/**
 * Which conversation a call belongs to, and its ids, without a table: each
 * comes from what names the conversation, through an HMAC with the app's
 * secret (the `links` resource's), so nobody without the secret can work
 * one out from another, and nothing maps sessions to chats.
 *
 * - **What names a conversation** (its key): ChatGPT's `openai/session`
 *   with its `openai/subject`, or a `chat` handle the app gave.
 * - **Its contact** is `c-<hmac>`, of the key, the line and the org; **its
 *   chat** is `mcp-<hmac>` of the contact. A contact, which is all an MCP
 *   call ever acts as, is in that chat and no other.
 * - **A handle** is 128 random bits, shown to the client and kept nowhere.
 * - **A call's id** is `mcp:<thread>:<request>:<what>`, hashes of the
 *   JSON-RPC request's id and of the tool and its input: a request sent
 *   again is the same call, and two different ones under the same request
 *   id (a client that counts from 1 for each call) never are. Nothing a
 *   client sends goes into it as it came.
 * - **A caller's address** is counted as `a-<hmac>`, never kept as it is.
 */

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA256 of `parts` (kept apart as JSON), in hex. */
async function mac(secret: string, parts: unknown[]): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(parts))));
}

/** What names a conversation: ChatGPT's session (and user), or a handle the app gave. */
export type Key = { session: string; subject?: string } | { handle: string };

/** Where a line is: its name, and the org it's for (with the orgs host). */
export type Scope = { line: string; org?: string };

/** The contact a conversation is, and its chat. */
export async function conversationOf(
  secret: string,
  scope: Scope,
  key: Key,
): Promise<{ contact: string; thread: string }> {
  const named = "session" in key
    ? ["session", key.session, key.subject ?? null]
    : ["handle", key.handle];
  const contact = `c-${
    (await mac(secret, ["mcp", "contact", scope.org ?? null, scope.line, ...named])).slice(0, 24)
  }`;
  return { contact, thread: await threadOf(secret, contact) };
}

/** A conversation's chat, from its contact. */
export const threadOf = async (secret: string, contact: string): Promise<string> =>
  `mcp-${(await mac(secret, ["mcp", "thread", contact])).slice(0, 32)}`;

/** A user, as their new conversations are counted (ChatGPT's `openai/subject`, never kept as it is). */
export const userOf = async (secret: string, scope: Scope, subject: string): Promise<string> =>
  `u-${(await mac(secret, ["mcp", "user", scope.org ?? null, scope.line, subject])).slice(0, 24)}`;

/** A caller's address, as its calls are counted. */
export const addressKey = async (secret: string, address: string): Promise<string> =>
  `a-${(await mac(secret, ["mcp", "address", address])).slice(0, 24)}`;

/** What a handle looks like: 128 bits, base64url. */
export const HANDLE = /^[A-Za-z0-9_-]{22}$/;

/** A new handle. */
export const newHandle = (): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const sha256 = async (value: unknown) =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value))));

/** What a call asks in its conversation, whatever its request's id: the same call sent again. */
export const sameCallOf = async (thread: string, tool: string, input: unknown): Promise<string> =>
  `mcp:${thread}:${(await sha256([tool, input])).slice(0, 16)}`;

/** A call's id: its conversation's chat, a hash of the request's id, and one of what it asks. */
export async function callIdOf(
  thread: string,
  request: string | number,
  tool: string,
  input: unknown,
): Promise<string> {
  const [asked, what] = await Promise.all([sha256(["request", request]), sha256([tool, input])]);
  return `mcp:${thread}:${asked.slice(0, 16)}:${what.slice(0, 16)}`;
}

/**
 * A widget's grant: what a call from the line's widgets carries to show it's theirs, never the
 * model's (its widget-only tools, `appOnly`, refuse a call without one).
 * `g2.<contact>.<until>.<hmac>`: the conversation's contact, until when it's good (seconds, base
 * 36), and an HMAC of both with the line and the org, with the app's secret. It goes out only in
 * results' `_meta` (the host's for the widget; a model never reads it), so the model can't make
 * one, and it's good for `GRANT_MS` (6 hours): a widget gets a new one with each reply, so one
 * in use never runs out, and one that leaked does. On a line where ChatGPT names every
 * conversation (`handles: false`), the call must name the grant's conversation too.
 */
export const GRANT_MS = 6 * 3_600_000;

export async function grantOf(
  secret: string,
  scope: Scope,
  contact: string,
  now = Date.now(),
): Promise<string> {
  const until = Math.floor((now + GRANT_MS) / 1000).toString(36);
  const said = await mac(secret, ["mcp", "grant", scope.org ?? null, scope.line, contact, until]);
  return `g2.${contact}.${until}.${said.slice(0, 32)}`;
}

/**
 * The contact a grant is for, when it's one this app made for this line and it's still good;
 * else undefined.
 */
export async function grantedTo(
  secret: string,
  scope: Scope,
  grant: unknown,
  now = Date.now(),
): Promise<string | undefined> {
  if (typeof grant !== "string" || grant.length > 120) return undefined;
  const found = /^g2\.(c-[0-9a-f]{24})\.([0-9a-z]{1,10})\.([0-9a-f]{32})$/.exec(grant);
  if (!found) return undefined;
  const [, contact, until] = found;
  if (parseInt(until, 36) * 1000 <= now) return undefined;
  const said = await mac(secret, ["mcp", "grant", scope.org ?? null, scope.line, contact, until]);
  const expected = `g2.${contact}.${until}.${said.slice(0, 32)}`;
  let differ = expected.length ^ grant.length;
  for (let i = 0; i < expected.length; i++) differ |= expected.charCodeAt(i) ^ grant.charCodeAt(i);
  return differ === 0 ? contact : undefined;
}
