/**
 * Finding and running Chrome (or Chromium, or Edge): hidden (headless) or
 * shown (a window on the person's screen), always muted, on a profile of its
 * own (never the person's), driven over a pipe rather than a debugging port.
 * It runs in its own process group (on Windows, its own tree), and stopping
 * it reaps everything it started.
 */
import { execFile, spawn } from "node:child_process";
import { access, constants, open, readlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { OWN, signalGroup, WINDOWS } from "../workloads/processes.ts";
import { browserError, deadline, race } from "./async.ts";
import { type Client, createClient, pipeWire } from "./cdp.ts";

/** Hidden: headless, nowhere on screen. Shown: a window on the person's screen. */
export type Window = "hidden" | "shown";

/** Whether its person lets agents show a browser window on this computer. */
export type Windows = "allow" | "never";

/** Whether a file is there and can be run. */
const runnable = (path: string) => access(path, constants.X_OK).then(() => true, () => false);

/**
 * The Chrome or Chromium this machine has, or null: `COPILOTZ_CHROMIUM` if
 * set, else the usual places: macOS apps; on Linux, by name on the PATH; on
 * Windows, where Chrome, Chromium and Edge install, for this person or all.
 */
export async function findChrome(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
) {
  const configured = env.COPILOTZ_CHROMIUM;
  if (configured) return await runnable(configured) ? configured : null;
  const candidates = platform === "darwin"
    ? ["", homedir()].flatMap((home) => [
      join(home, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      join(home, "/Applications/Chromium.app/Contents/MacOS/Chromium"),
    ])
    : platform === "win32"
    ? [
      ["Google", "Chrome", "Application", "chrome.exe"],
      ["Chromium", "Application", "chrome.exe"],
      ["Microsoft", "Edge", "Application", "msedge.exe"],
    ].flatMap((path) =>
      [env.LOCALAPPDATA, env.ProgramFiles, env["ProgramFiles(x86)"]]
        .filter((dir): dir is string => !!dir).map((dir) => join(dir, ...path))
    )
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].flatMap((name) =>
      (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name))
    );
  for (const path of candidates) if (await runnable(path)) return path;
  return null;
}

/**
 * Why a window can't be shown on this computer, or undefined when it can: its
 * person turned windows off (`denied`), or, on Linux, there's no display to
 * show one on (`no_display`).
 */
export function cannotShow(
  windows: Windows | undefined,
  env: Record<string, string | undefined>,
  platform: string = process.platform,
): { code: string; message: string } | undefined {
  if (windows === "never") {
    return {
      code: "denied",
      message:
        "The person turned browser windows off on this computer (--windows=never): use the hidden browser",
    };
  }
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return {
      code: "no_display",
      message:
        "This computer has no display to show a window on (no DISPLAY or WAYLAND_DISPLAY): use the hidden browser",
    };
  }
}

/** The command line of process `pid`, or "" when it's gone (or ps is denied). */
const commandOf = (pid: number) =>
  new Promise<string>((resolve) => {
    execFile(
      "/bin/ps",
      ["-ww", "-o", "command=", "-p", String(pid)],
      { cwd: "/" },
      (error, out) => {
        resolve(error ? "" : out.trim());
      },
    );
  });

/**
 * The pid of another Chrome running on `profile`, if there is one (0 when
 * it's there but its pid isn't known). Chrome locks its profile
 * (`SingletonLock`, a link to `<host>-<pid>`); a second one started on it
 * would hand its work to the first, and end. On Windows it holds the
 * profile's `lockfile` open, others only reading it, while it runs.
 */
export async function profileOwner(profile: string): Promise<number | undefined> {
  if (WINDOWS) {
    const held = await open(join(profile, "lockfile"), "r+").then(
      async (file) => (await file.close(), false),
      (error: NodeJS.ErrnoException) => ["EBUSY", "EPERM", "EACCES"].includes(error.code ?? ""),
    );
    return held ? 0 : undefined;
  }
  const lock = await readlink(join(profile, "SingletonLock")).catch(() => "");
  const match = /^(.*)-(\d+)$/.exec(lock);
  if (!match || match[1] !== hostname()) return undefined;
  const pid = Number(match[2]);
  const command = `${await commandOf(pid)} `;
  return command.includes(`--user-data-dir=${profile} `) ? pid : undefined;
}

export type LaunchOptions = {
  chromium: string;
  /** Its user data directory. */
  profile: string;
  /** Hidden unless shown. */
  window?: Window;
  /** What a shown window is called, where Chrome supports it (`--window-name`). */
  title?: string;
  /** The user agent it presents (its own unless given). */
  userAgent?: string;
  width?: number;
  height?: number;
  env?: Record<string, string>;
  launchTimeoutMs?: number;
  closeTimeoutMs?: number;
  /** Hears it start and stop (its pid only). */
  onProcess?: (event: { pid: number; state: "started" | "stopped" }) => void;
};

/** A running Chrome: hidden or shown, and its product and user agent, as it says them. */
export type Chrome = {
  client: Client;
  pid: number;
  window: Window;
  /** Like `Chrome/141.0.7390.54`. */
  product: string;
  userAgent: string;
  close(): Promise<void>;
};

/** Every process descending from `pid` (ps may be denied; then none; on Windows, a kill ends them). */
function descendants(pid: number): Promise<number[]> {
  if (WINDOWS) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-axo", "pid=,ppid="], { cwd: "/" }, (error, stdout) => {
      if (error) return resolve([]);
      const rows = stdout.trim().split("\n").map((row) => row.trim().split(/\s+/).map(Number));
      const found = new Set([pid]);
      for (let changed = true; changed;) {
        changed = false;
        for (const [child, parent] of rows) {
          if (found.has(parent) && !found.has(child)) {
            found.add(child);
            changed = true;
          }
        }
      }
      found.delete(pid);
      resolve([...found]);
    });
  });
}

const kill = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
};

function notify(options: LaunchOptions, pid: number, state: "started" | "stopped") {
  try {
    options.onProcess?.({ pid, state });
  } catch {
    // What only watches can't break cleanup.
  }
}

/**
 * Starts Chrome on `options.profile`, ready for DevTools commands; `busy` when
 * another Chrome has that profile.
 */
export async function launch(options: LaunchOptions, signal: AbortSignal): Promise<Chrome> {
  const window = options.window ?? "hidden";
  const shown = window === "shown";
  const owner = await profileOwner(options.profile);
  if (owner !== undefined) {
    throw browserError(
      "busy",
      `Another Chrome${
        owner ? ` (pid ${owner})` : ""
      } has this browser's profile, ${options.profile}: ` +
        "close it, or stop the other computer program using this root",
    );
  }
  const width = options.width ?? 1280;
  const height = (options.height ?? 720) + (shown ? 100 : 0);
  const args = [
    "--remote-debugging-pipe",
    ...(shown ? [] : ["--headless=new"]),
    "--mute-audio",
    `--user-data-dir=${options.profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Pages aren't told it's driven (navigator.webdriver), nor offered to restore after a kill.
    "--disable-blink-features=AutomationControlled",
    "--hide-crash-restore-bubble",
    ...(options.userAgent ? [`--user-agent=${options.userAgent}`] : []),
    ...(shown && options.title ? [`--window-name=${options.title}`] : []),
    // Wayland's own display when there is one, else X11's.
    ...(shown && process.platform === "linux" ? ["--ozone-platform-hint=auto"] : []),
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : ["--password-store=basic"]),
    // Chrome refuses to run as root with its sandbox.
    ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    `--window-size=${width},${height}`,
    "about:blank",
  ];
  const child = spawn(options.chromium, args, {
    cwd: "/",
    env: options.env,
    // DevTools' pipe, as Puppeteer gives it: Chrome reads commands on fd 3 and writes on fd 4.
    stdio: [
      "ignore",
      "ignore",
      process.env.COPILOTZ_BROWSER_DEBUG === "1" ? "inherit" : "ignore",
      "pipe",
      "pipe",
    ],
    // Its own process group (see processes.ts): stopping it reaches its helpers and renderers.
    ...OWN,
  });
  const exited = new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
  const pid = child.pid ?? 0;
  if (pid) notify(options, pid, "started");

  /** Ends it: SIGTERM to its group, then SIGKILL (on Windows, its whole tree at once). */
  const stop = async (children?: number[]) => {
    if (!pid) return;
    children ??= await descendants(pid);
    signalGroup(pid, WINDOWS ? "SIGKILL" : "SIGTERM");
    const limit = deadline(1500);
    try {
      await race(exited, limit.signal);
    } catch {
      signalGroup(pid, "SIGKILL");
      await exited;
    } finally {
      limit.dispose();
    }
    // Its group, or what left it, can outlive the browser itself.
    signalGroup(pid, "SIGKILL");
    for (const descendant of children) kill(descendant, "SIGKILL");
  };

  const startup = deadline(options.launchTimeoutMs ?? 20_000, signal);
  const client = createClient(pipeWire(child.stdio[4] as Readable, child.stdio[3] as Writable));
  let version: { product: string; userAgent: string };
  try {
    version = await client.send("Browser.getVersion", {}, startup.signal);
  } catch (error) {
    await stop();
    await client.close();
    if (pid) notify(options, pid, "stopped");
    throw error;
  } finally {
    startup.dispose();
  }
  let closing: Promise<void> | undefined;
  return {
    client,
    pid,
    window,
    product: version.product,
    userAgent: version.userAgent,
    close() {
      return closing ??= (async () => {
        const limit = deadline(options.closeTimeoutMs ?? 10_000);
        let children: number[] = [];
        try {
          children = await descendants(pid);
          // The pipe can close before Browser.close answers: its exit says it's done.
          await client.send("Browser.close", {}, limit.signal).catch(() => {});
          await race(exited, limit.signal).catch(() => {});
        } finally {
          limit.dispose();
          await stop(children);
          await client.close();
          notify(options, pid, "stopped");
        }
      })();
    },
  };
}
