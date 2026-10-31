/**
 * What the computer keeps between runs, in `computer.json` in its folder
 * (`~/.config/copilotz`, `$XDG_CONFIG_HOME/copilotz`, or on Windows
 * `%LOCALAPPDATA%\Copilotz`, this machine's own: it's this machine's
 * identity), readable only by its user (`COPILOTZ_COMPUTER_STATE` puts it
 * elsewhere): each app (or org) it's connected to, with its id and secret
 * there once enrolled and the folder its spaces go in; its name; and whether
 * agents may show browser windows. One machine serves many orgs, each as a
 * computer of its own there, its spaces under a folder of its own.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { plainName } from "../shared/folder.ts";
import type { Windows } from "./browser/chrome.ts";
import { alive } from "./workloads/processes.ts";

export type { Windows } from "./browser/chrome.ts";

/** An app (or an org of one) this machine is a computer of. */
export type Connection = {
  /** The app's URL, as given (an org's address: `https://host/o/acme`). */
  url: string;
  /** Its id and secret there, once enrolled. */
  id?: string;
  secret?: string;
  /** Where its spaces' folders are. */
  root: string;
};

export type State = {
  /** The apps it's connected to, each its own computer there. */
  connections: Connection[];
  name?: string;
  /** `never`: agents' browsers stay hidden, never a window on this screen (`connect --windows`). */
  windows?: Windows;
};

/** A `--windows` (or `COPILOTZ_BROWSER_WINDOWS`) value, checked; undefined stays undefined. */
export function windowsSetting(value: string | undefined, from: string): Windows | undefined {
  if (value === undefined || value === "allow" || value === "never") return value;
  throw new Error(`${from} is "allow" or "never", not "${value}"`);
}

/** The program's own folder for this person (see above). */
export const ownFolder = (): string =>
  process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Copilotz")
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "copilotz");

/** Where the state file is. */
export const statePath = (): string =>
  process.env.COPILOTZ_COMPUTER_STATE ?? join(ownFolder(), "computer.json");

/** Where spaces' folders go unless told otherwise: `~/Copilotz` (`%USERPROFILE%\Copilotz`). */
export const defaultRoot = (): string => join(homedir(), "Copilotz");

/** The state kept at `path`, or undefined when there's none. */
export async function loadState(path = statePath()): Promise<State | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return undefined;
    throw error;
  }
  const kept = JSON.parse(text);
  // Kept before a machine served many: its one connection, its folder as it was.
  if (typeof kept?.url === "string" && typeof kept.root === "string") {
    const { url, id, secret, root, name, windows } = kept;
    return {
      connections: [{ url, root, ...(id ? { id } : {}), ...(secret ? { secret } : {}) }],
      ...(name ? { name } : {}),
      ...(windows ? { windows } : {}),
    };
  }
  const state = kept as State;
  if (
    !Array.isArray(state?.connections) ||
    !state.connections.every((c) => typeof c?.url === "string" && typeof c.root === "string")
  ) {
    throw new Error(`${path} isn't a computer's state: run \`forget\`, then \`connect\` again`);
  }
  return state;
}

/** Whether two URLs are the same app (or org): they connect to the same socket. */
export const sameApp = (a: string, b: string): boolean => socketUrl(a) === socketUrl(b);

/** The connection to `url`'s app in `state`, if it has one. */
export const connectionOf = (state: State | undefined, url: string): Connection | undefined =>
  state?.connections.find((c) => sameApp(c.url, url));

/** `state` with `connection` in it, in place of one to the same app. */
export const withConnection = (state: State | undefined, connection: Connection): State => ({
  ...state,
  connections: [
    ...(state?.connections ?? []).filter((c) => !sameApp(c.url, connection.url)),
    connection,
  ],
});

/** What changes the state goes one at a time in this process: each reads what the last wrote. */
const changing = new Map<string, Promise<unknown>>();

/** Changes the state at `path`: `change` gets it as it is (or undefined) and gives it as it'll be. */
export function updateState(
  path: string,
  change: (state: State | undefined) => State | Promise<State>,
): Promise<State> {
  const done = (changing.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const state = await change(await loadState(path));
    await saveState(state, path);
    return state;
  });
  changing.set(path, done);
  return done;
}

/**
 * The folder an app's spaces go in under the root: `name`, as the app says
 * (its org's, `acme`), plain; else its org's id (`/o/o-1a2b` is `o-1a2b`),
 * else its host. One already taken is numbered (`acme-2`).
 */
export function folderFor(url: string, taken: string[] = [], name?: string): string {
  const parsed = new URL(url);
  const org = /^\/o\/([^/]+)/.exec(parsed.pathname)?.[1];
  const base = name && plainName(name, "")
    ? plainName(name)
    : (org ? decodeURIComponent(org) : parsed.hostname).replace(/[^\w.-]+/g, "-") || "app";
  let folder = base;
  for (let n = 2; taken.includes(folder); n++) folder = `${base}-${n}`;
  return folder;
}

/** Keeps `state` at `path`, readable only by this user, replacing it whole. */
export async function saveState(state: State, path = statePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Holds the state at `path` for this process (`<path>.lock`, its pid): one
 * computer runs on a state at a time, as two would take turns being it.
 * While another that's running holds it, this fails (`running`). It answers
 * what lets go of it; one that ended without letting go is taken over.
 */
export async function holdState(path = statePath()): Promise<() => Promise<void>> {
  const lock = `${path}.lock`;
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  for (let tries = 1;; tries++) {
    try {
      await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      return async () => {
        const held = await readFile(lock, "utf8").catch(() => "");
        if (held === String(process.pid)) await rm(lock, { force: true });
      };
    } catch (error) {
      if ((error as { code?: string })?.code !== "EEXIST" || tries === 3) throw error;
      const pid = Number(await readFile(lock, "utf8").catch(() => ""));
      // One stopping (a service restarting it) has a moment to be gone.
      for (let waited = 0; pid && pid !== process.pid && alive(pid); waited += 250) {
        if (waited >= 5_000) {
          throw Object.assign(
            new Error(`This computer is already running (pid ${pid}): stop that one first`),
            { code: "running" },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await rm(lock, { force: true });
    }
  }
}

/** Deletes the state; false when there was none. */
export async function forgetState(path = statePath()): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * The socket a computer connects to: `ws(s)://…` as it is; `http(s)://host`
 * becomes `ws(s)://host/oxian`, the web host's, under the app's path when it
 * is an org's (of a host serving many: `https://host/o/acme` connects to
 * `wss://host/o/acme/oxian`).
 */
export function socketUrl(app: string): string {
  let url: URL;
  try {
    url = new URL(app);
  } catch {
    throw new Error(`"${app}" isn't a URL: give the app's, like https://app.example.com`);
  }
  if (url.protocol === "ws:" || url.protocol === "wss:") return url.href;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`"${app}" isn't an http(s) or ws(s) URL`);
  }
  // Of a path, only an org's address counts (a page's link pasted whole doesn't).
  const org = /^\/o\/[^/]+/.exec(url.pathname)?.[0] ?? "";
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}${org}/oxian`;
}

/** The hosts a computer may reach over plain `ws:`: this machine's own. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * A socket a computer can connect to, or why not: over `wss:`, or `ws:` to
 * this machine only (an app on another, over plain `ws:`, would be refused,
 * so it fails here, saying so, rather than waiting to connect).
 */
export function reachable(socket: string): string {
  const url = new URL(socket);
  if (url.protocol === "ws:" && !LOOPBACK.has(url.hostname)) {
    throw new Error(
      `${socket}: an app on another machine is reached over https (wss:); plain http (ws:) only ` +
        "reaches one on this machine (localhost)",
    );
  }
  return socket;
}

/** A root as given (`~` is home), made absolute. */
export const rootPath = (root: string): string =>
  resolve(root === "~" ? homedir() : /^~[/\\]/.test(root) ? join(homedir(), root.slice(2)) : root);
