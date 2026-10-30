/**
 * What the computer keeps between runs, in `computer.json` in its folder
 * (`~/.config/copilotz`, `$XDG_CONFIG_HOME/copilotz`, or on Windows
 * `%LOCALAPPDATA%\Copilotz`, this machine's own: it's this machine's
 * identity), readable only by its user (`COPILOTZ_COMPUTER_STATE` puts it
 * elsewhere): the app it connects to, its id and secret once enrolled, its
 * root, its name, and whether agents may show browser windows.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import type { Windows } from "./browser/chrome.ts";
import { alive } from "./workloads/processes.ts";

export type { Windows } from "./browser/chrome.ts";

export type State = {
  /** The app's URL, as given. */
  url: string;
  id?: string;
  secret?: string;
  /** Where spaces' folders are. */
  root: string;
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
  const state = JSON.parse(text) as State;
  if (typeof state?.url !== "string" || typeof state.root !== "string") {
    throw new Error(`${path} isn't a computer's state: run \`forget\`, then \`connect\` again`);
  }
  return state;
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
      if (pid && pid !== process.pid && alive(pid)) {
        throw Object.assign(
          new Error(`This computer is already running (pid ${pid}): stop that one first`),
          { code: "running" },
        );
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
 * becomes `ws(s)://host/oxian`, the web host's.
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
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/oxian`;
}

/** A root as given (`~` is home), made absolute. */
export const rootPath = (root: string): string =>
  resolve(root === "~" ? homedir() : /^~[/\\]/.test(root) ? join(homedir(), root.slice(2)) : root);
