/**
 * The computer program: run it once on a machine to let an app's agents
 * (and people) use it, each space in a folder of its own under its root.
 *
 *   computer install <app-url> --code <CODE> [--root <dir>] [--name <label>] [--windows <w>]
 *                                      connect it, then keep it running in the background
 *   computer connect <app-url> --code <CODE> [--root <dir>] [--name <label>] [--windows <w>]
 *                                      connect it, and keep it running here
 *   computer [run] [--root <dir>] [--windows <w>] [--log <file>]
 *                                      run as the computer it was connected as
 *   computer install | uninstall       start it at login and keep it running, or stop that
 *   computer forget                    forget it (its folders stay)
 *
 * `--windows never` (or `COPILOTZ_BROWSER_WINDOWS=never`) keeps agents'
 * browsers hidden: none is ever shown on this screen. `connect` keeps it;
 * `run` can override it, for that run.
 *
 * It runs under `deno run -A`, `node` and `bun`, and as the binary
 * `scripts/computer/build.ts` makes, which updates itself when the app offers
 * a newer one, and starts again as it. Ctrl-C (or SIGTERM) stops it, and
 * every shell, job and browser it started. One runs per state at a time.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import process from "node:process";
import { parseArgs } from "node:util";
import { type Computer, type ComputerOptions, startComputer } from "./computer.ts";
import { installedPath, installService, serviceOf, uninstallService } from "./service.ts";
import {
  defaultRoot,
  forgetState,
  holdState,
  loadState,
  rootPath,
  saveState,
  socketUrl,
  statePath,
  windowsSetting,
} from "./state.ts";
import { copyProgram, PROGRAM, tidyAside } from "./update.ts";
import { VERSION } from "./version.ts";
import { exitCode, WINDOWS } from "./workloads/processes.ts";

const USAGE = `Copilotz computer ${VERSION}

  computer install <app-url> --code <CODE> [--root <dir>] [--name <label>] [--windows allow|never]
      Connects this machine to an app with a code from it, then keeps it
      running in the background, from login on (as the installed program).
  computer connect <app-url> --code <CODE> [--root <dir>] [--name <label>] [--windows allow|never]
      Connects this machine to an app with a code from it, then keeps running here.
      Spaces' folders go under --root (${defaultRoot()} unless given).
  computer [run] [--root <dir>] [--windows allow|never] [--log <file>]
      Runs as the computer it was connected as (--log: also what it says, to <file>).
  computer install
      Starts it at login and keeps it running in the background (it starts now too).
  computer uninstall
      Stops that: it stops, and no longer starts at login.
  computer forget
      Forgets it (its id and secret), and uninstalls it; its folders stay.

Agents' browsers are hidden unless they show one on this screen (to let you
sign in, say). --windows never keeps them hidden, always; connect keeps it,
and run can override it for that run. COPILOTZ_BROWSER_WINDOWS=never does the
same, unless --windows says otherwise.

State: ${statePath()} (COPILOTZ_COMPUTER_STATE puts it elsewhere).`;

/** How a computer that updated itself ends, so whoever started it this way starts it again. */
const UPDATED = 75;

/** A path as people say it here, with `~` for home. */
const tilde = (path: string) =>
  path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;

/**
 * Starts this program again as it is on disk now (updated), with `argv`, and
 * ends as it does. A program it started so says `UPDATED` when it updates in
 * turn, and is started again from here: one waits, never more. On Windows,
 * Ctrl-C reaches both already (their console's).
 */
async function relaunch(argv: string[]): Promise<never> {
  if (process.env.COPILOTZ_COMPUTER_RELAUNCHED) process.exit(UPDATED);
  for (;;) {
    const child = spawn(PROGRAM!, argv, {
      stdio: "inherit",
      env: { ...process.env, COPILOTZ_COMPUTER_RELAUNCHED: "1" },
    });
    const pass = (signal: NodeJS.Signals) => void child.kill(signal);
    if (!WINDOWS) { for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, pass); }
    const code = await new Promise<number>((resolve) => {
      child.on("error", () => resolve(1));
      child.on("exit", (code, signal) => resolve(exitCode(code, signal)));
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.off(signal, pass);
    if (code !== UPDATED) process.exit(code);
  }
}

/**
 * Runs a computer until a signal stops it (or the app turns it away), holding
 * its state; updated, it starts again as the new version (`again`'s
 * arguments). Turned away, it ends with `away`: 0 when running as itself, so
 * what starts it at login doesn't try again in vain.
 */
async function serve(options: ComputerOptions, again: string[], away: number) {
  const say = options.log ?? console.log;
  const release = await holdState(options.statePath);
  let computer: Computer;
  try {
    computer = await startComputer(options);
  } catch (error) {
    await release();
    throw error;
  }
  say(
    `spaces under ${computer.info.root}; browser: ${computer.info.browser ?? "none found"}` +
      (options.windows === "never" ? " (always hidden: --windows never)" : ""),
  );
  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    await computer.stop();
    await release();
    process.exit(code);
  };
  const signalled = () => void stop(0);
  process.on("SIGINT", signalled);
  process.on("SIGTERM", signalled);
  try {
    if (await computer.closed === "updated") {
      // Stopped already; from here, the new one's signals are its own.
      process.off("SIGINT", signalled);
      process.off("SIGTERM", signalled);
      await release();
      await relaunch(again);
    }
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    await stop((error as { code?: string })?.code === "refused" ? away : 1);
  }
}

/**
 * Enrolls this machine with a code, then stops: what `install` does before
 * the background takes over. It lingers a moment once enrolled, for the app
 * to hear its answer and finish taking it in (if it doesn't, the app tells it
 * again when it next comes).
 */
async function enroll(options: ComputerOptions) {
  const release = await holdState(options.statePath);
  const late = setTimeout(() => console.log("still connecting…"), 10_000);
  let computer: Computer | undefined;
  try {
    computer = await startComputer(options);
    await Promise.race([computer.enrolled, computer.closed]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } finally {
    clearTimeout(late);
    await computer?.stop();
    await release();
  }
}

/** The program, installed: run from source, it can't keep itself running. */
function installed(): string {
  if (PROGRAM) return PROGRAM;
  throw new Error(
    "Run from source, it can't install itself: install the program (the app's install " +
      "command), or start `computer run` your own way",
  );
}

/**
 * Starts it at login and keeps it running (see service.ts), saying how; run
 * from elsewhere (where it was downloaded), it's copied where it's kept first.
 */
async function install() {
  const program = installedPath();
  const real = (path: string) => realpath(path).catch(() => path);
  if (await real(installed()) !== await real(program)) {
    await copyProgram(installed(), program);
    console.log(`installed: ${tilde(program)}`);
  }
  const service = serviceOf({ program });
  await installService(service);
  console.log(
    `It runs in the background now, and starts when you log in (${service.kind}).\n` +
      `  what it says: ${tilde(service.logs)}\n` +
      "  to stop it:   computer uninstall",
  );
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      code: { type: "string" },
      root: { type: "string" },
      name: { type: "string" },
      windows: { type: "string" },
      log: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command = "run", ...rest] = positionals;
  if (values.help || command === "help") return console.log(USAGE);
  if (values.version) return console.log(VERSION);
  if (PROGRAM && WINDOWS) await tidyAside(PROGRAM);
  const path = statePath();
  // Windows as said here, else in the environment, else as kept.
  const said = windowsSetting(values.windows, "--windows");
  const windows = () =>
    said ??
      windowsSetting(process.env.COPILOTZ_BROWSER_WINDOWS || undefined, "COPILOTZ_BROWSER_WINDOWS");
  // What it says, timed when it's not said to a person (a log), and to --log's file too.
  const log = (line: string) => {
    const timed = `${new Date().toISOString()} ${line}`;
    console.log(process.stdout.isTTY ? line : timed);
    if (values.log) appendFileSync(values.log, `${timed}\n`);
  };

  if (command === "connect" || (command === "install" && rest.length)) {
    const [url] = rest;
    if (!url || !values.code) throw new Error(`Usage: computer ${command} <app-url> --code <CODE>`);
    if (command === "install") installed();
    socketUrl(url);
    const root = rootPath(values.root ?? defaultRoot());
    // A new enrollment: whatever it was before is replaced once the app answers.
    await saveState({
      url,
      root,
      ...(values.name ? { name: values.name } : {}),
      ...(said ? { windows: said } : {}),
    }, path);
    log(`connecting to ${url}…`);
    const options = {
      url,
      root,
      statePath: path,
      code: values.code,
      ...(values.name ? { name: values.name } : {}),
      windows: windows() ?? "allow",
      log,
    };
    if (command === "connect") return await serve(options, ["run"], 1);
    await enroll(options);
    return await install();
  }

  if (command === "install") {
    const state = await loadState(path);
    if (!state?.id || !state.secret) {
      throw new Error("Not connected yet: run `computer install <app-url> --code <CODE>`");
    }
    return await install();
  }

  if (command === "uninstall") {
    const removed = await uninstallService(serviceOf({ program: installedPath() }));
    return console.log(
      removed
        ? "It stopped, and no longer starts at login (`computer install` starts it again)."
        : "It wasn't installed.",
    );
  }

  if (command === "run") {
    const state = await loadState(path);
    if (!state) {
      throw new Error("Not connected yet: run `computer connect <app-url> --code <CODE>`");
    }
    if (!state.id || !state.secret) {
      throw new Error("Not enrolled: get a new code and run `computer connect` again");
    }
    return await serve(
      {
        url: state.url,
        root: values.root ? rootPath(values.root) : state.root,
        statePath: path,
        ...(state.name ? { name: state.name } : {}),
        windows: windows() ?? state.windows ?? "allow",
        log,
      },
      argv,
      0,
    );
  }

  if (command === "forget") {
    await uninstallService(serviceOf({ program: installedPath() }));
    const forgot = await forgetState(path);
    return console.log(
      forgot ? `Forgot this computer (${path}); its folders stay.` : "Nothing to forget.",
    );
  }

  throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
