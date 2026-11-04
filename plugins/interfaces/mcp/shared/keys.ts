/**
 * Which conversation a call belongs to, and its ids, without a table: each
 * comes from what names the conversation, through an HMAC with the app's
 * secret (the `links` resource's), so nobody without the secret can work
 * one out from another, and nothing maps sessions to chats.
 *
 * - **What names a conversation** (its key): ChatGPT's `openai/session`
 *   with its `openai/subject`, or a `chat` handle the app gave, or, for a
 *   call that names none, something new.
 * - **Its contact** is `c-<hmac>`, of the key, the line and the org; **its
 *   chat** is `mcp-<hmac>` of the contact. A contact, which is all an MCP
 *   call ever acts as, is in that chat and no other.
 * - **A handle** is 128 random bits, shown to the client and kept nowhere.
 * - **A call's id** is `mcp:<thread>:<request id>:<what>`, `what` a hash of
 *   the tool and its input: a request sent again is the same call, and two
 *   different ones under the same request id (a client that counts from 1
 *   for each call) never are.
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

/** What names a conversation: ChatGPT's session (and user), a handle, or nothing (a new one). */
export type Key =
  | { session: string; subject?: string }
  | { handle: string }
  | { fresh: string };

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
    : "handle" in key
    ? ["handle", key.handle]
    : ["fresh", key.fresh];
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

/** What a handle looks like: 128 bits, base64url. */
export const HANDLE = /^[A-Za-z0-9_-]{22}$/;

/** A new handle. */
export const newHandle = (): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** A call's id: its conversation's chat, the request's id, and a hash of what it asks. */
export async function callIdOf(
  thread: string,
  request: string | number,
  tool: string,
  input: unknown,
): Promise<string> {
  const what = hex(
    await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify([tool, input]))),
  );
  return `mcp:${thread}:${request}:${what.slice(0, 16)}`;
}
