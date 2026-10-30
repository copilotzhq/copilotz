/**
 * The computer program: run it once on a machine to let an app's agents
 * (and people) use it, each space in a folder of its own under its root.
 * One machine serves many apps (or orgs of one): each is a computer of its
 * own there, its spaces under a folder of its own (`~/Copilotz/<org>`).
 *
 *   computer install <app-url> --code <CODE> [--root <dir>] [--name <label>] [--windows <w>]
 *                                      connect it (adding this app), then keep it running
 *                                      in the background
 *   computer connect <app-url> --code <CODE> [--root <dir>] [--name <label>] [--windows <w>]
 *                                      connect it (adding this app), and keep it running here
 *   computer [run] [--root <dir>] [--windows <w>] [--log <file>]
 *                                      run as the computer it was connected as, to every app
 *   computer list                      the apps it's connected to, and where their spaces are
 *   computer disconnect <app-url>      disconnect it from an app (its folder stays)
 *   computer install | uninstall       start it at login and keep it running, or stop that
 *   computer forget                    forget it, for every app (its folders stay)
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
import { basename, join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { type Computer, type ComputerOptions, startComputer } from "./computer.ts";
import {
  installedPath,
  installService,
  serviceInstalled,
  serviceOf,
  stopService,
  uninstallService,
} from "./service.ts";
import {
  type Connection,
  connectionOf,
  defaultRoot,
  folderFor,
  forgetState,
  holdState,
  loadState,
  rootPath,
  sameApp,
  socketUrl,
  type State,
  statePath,
  updateState,
  windowsSetting,
  withConnection,
} from "./state.ts";
import { copyProgram, PROGRAM, tidyAside } from "./update.ts";
import { VERSION } from "./version.ts";
import { exitCode, WINDOWS } from "./workloads/processes.ts";

const USAGE = `Copilotz computer ${VERSION}

  computer install <app-url> --code <CODE> [--root <dir>] [--name <label>] [--windows allow|never]
      Connects this machine to an app (or an org) with a code from it, then keeps
      it running in the background, from login on (as the installed program).
      Connected to others already, it adds this one: a computer of its own there.
  computer connect <app-url> --code <CODE> [--root <dir>] [--name <label>] [--windows allow|never]
      Connects this machine to an app with a code from it, then keeps running here.
      Each app's spaces go in a folder of its own under --root (${defaultRoot()}
      unless given).
  computer [run] [--root <dir>] [--windows allow|never] [--log <file>]
      Runs as the computer it was connected as, to every app (--log: also what it
      says, to <file>).
  computer list
      The apps it's connected to, and where each one's spaces are.
  computer disconnect <app-url>
      Disconnects it from that app (restarting it if it runs in the background);
      that app's folder stays.
  computer install
      Starts it at login and keeps it running in the background (it starts now too).
  computer uninstall
      Stops that: it stops, and no longer starts at login.
  computer forget
      Forgets it (its ids and secrets, for every app), and uninstalls it; its
      folders stay.

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
 * Runs a computer for each app it's connected to, until a signal stops them,
 * holding the state. One updated, they all stop and it starts again as the
 * new version (`again`'s arguments). One the app turns away stops, saying
 * so; the rest run on. None left, it ends with `away`: 0 when running as
 * itself, so what starts it at login doesn't try again in vain.
 */
async function serve(list: ComputerOptions[], again: string[], away: number) {
  const say = list[0].log ?? console.log;
  const release = await holdState(list[0].statePath);
  const computers: Computer[] = [];
  try {
    for (const options of list) computers.push(await startComputer(options));
  } catch (error) {
    await Promise.allSettled(computers.map((computer) => computer.stop()));
    await release();
    throw error;
  }
  for (const [i, computer] of computers.entries()) {
    say(`${list[i].url}: spaces under ${tilde(computer.info.root)}`);
  }
  say(
    `browser: ${computers[0].info.browser ?? "none found"}` +
      (list[0].windows === "never" ? " (always hidden: --windows never)" : ""),
  );
  let stopping = false;
  const stopAll = async () => {
    stopping = true;
    await Promise.allSettled(computers.map((computer) => computer.stop()));
    await release();
  };
  const signalled = () => {
    if (!stopping) void stopAll().then(() => process.exit(0));
  };
  process.on("SIGINT", signalled);
  process.on("SIGTERM", signalled);
  // How each ends: updated (they all start again as the new one), turned away (it alone), stopped.
  const ends = computers.map((computer, i) =>
    computer.closed.then((how) => ({ i, how }), (error: unknown) => ({ i, error }))
  );
  const running = new Set(computers.keys());
  let code = away;
  while (running.size && !stopping) {
    const end = await Promise.race([...running].map((i) => ends[i]));
    running.delete(end.i);
    if ("how" in end && end.how === "updated") {
      // Stopped already; from here, the new one's signals are its own.
      process.off("SIGINT", signalled);
      process.off("SIGTERM", signalled);
      await stopAll();
      await relaunch(again);
    }
    if ("error" in end) {
      const { error } = end;
      say(`${list[end.i].url}: ${error instanceof Error ? error.message : String(error)}`);
      // Not turned away (something broke): it ends, to be started again.
      if ((error as { code?: string })?.code !== "refused") code = 1;
      if (code === 1) break;
    }
  }
  // A signal stops them, and ends it (see `signalled`).
  if (stopping) return;
  await stopAll();
  process.exit(code);
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

  /** How a connection runs: its app, its folder, and what this machine is. */
  const optionsOf = (connection: Connection, name?: string, kept?: State["windows"]) => ({
    url: connection.url,
    root: connection.root,
    statePath: path,
    ...(name ? { name } : {}),
    windows: windows() ?? kept ?? "allow",
    log,
  });

  if (command === "connect" || (command === "install" && rest.length)) {
    const [url] = rest;
    if (!url || !values.code) throw new Error(`Usage: computer ${command} <app-url> --code <CODE>`);
    if (command === "install") installed();
    socketUrl(url);
    // Connected to it already, its folder stays; else a folder of its own under the root.
    const before = await loadState(path);
    const known = connectionOf(before, url);
    const root = known?.root ?? join(
      rootPath(values.root ?? defaultRoot()),
      folderFor(url, (before?.connections ?? []).map((c) => basename(c.root))),
    );
    // A new enrollment there: its old id and secret go; the other apps' stay.
    const state = await updateState(path, (state) => ({
      ...withConnection(state, { url, root }),
      ...(values.name ? { name: values.name } : {}),
      ...(said ? { windows: said } : {}),
    }));
    log(`connecting to ${url}…`);
    const added = { ...optionsOf({ url, root }, state.name, state.windows), code: values.code };
    if (command === "connect") {
      const others = state.connections.filter((c) => !sameApp(c.url, url) && c.id && c.secret);
      return await serve(
        [added, ...others.map((c) => optionsOf(c, state.name, state.windows))],
        ["run"],
        1,
      );
    }
    // Running in the background, it holds the state: it stops while this enrolls, and starts
    // again with every app (`install`).
    await stopService(serviceOf({ program: installedPath() }));
    await enroll(added);
    return await install();
  }

  if (command === "install") {
    const state = await loadState(path);
    if (!state?.connections.some((c) => c.id && c.secret)) {
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
    if (!state?.connections.length) {
      throw new Error("Not connected yet: run `computer connect <app-url> --code <CODE>`");
    }
    const enrolled = state.connections.filter((c) => c.id && c.secret);
    for (const c of state.connections) {
      if (!c.id || !c.secret) log(`${c.url}: not enrolled (get a new code and connect again)`);
    }
    if (!enrolled.length) {
      throw new Error("Not enrolled: get a new code and run `computer connect` again");
    }
    if (values.root && enrolled.length > 1) {
      throw new Error("--root names one app's folder: connected to several, each keeps its own");
    }
    return await serve(
      enrolled.map((c) =>
        optionsOf(
          values.root ? { ...c, root: rootPath(values.root) } : c,
          state.name,
          state.windows,
        )
      ),
      argv,
      0,
    );
  }

  if (command === "list") {
    const state = await loadState(path);
    if (!state?.connections.length) {
      return console.log(
        "Not connected to any app yet: `computer connect <app-url> --code <CODE>`",
      );
    }
    for (const c of state.connections) {
      console.log(
        `${c.url}\n  spaces under ${tilde(c.root)}; ${c.id ? `computer ${c.id}` : "not enrolled"}`,
      );
    }
    return;
  }

  if (command === "disconnect") {
    const [url] = rest;
    if (!url) throw new Error("Usage: computer disconnect <app-url>");
    const gone = connectionOf(await loadState(path), url);
    if (!gone) return console.log(`Not connected to ${url} (\`computer list\` says to which).`);
    // Running in the background, it holds the state: it stops, and starts again without it.
    const service = serviceOf({ program: installedPath() });
    const background = await serviceInstalled(service);
    if (background) await stopService(service);
    const state = await updateState(path, (state) => ({
      ...state!,
      connections: state!.connections.filter((c) => !sameApp(c.url, url)),
    }));
    console.log(
      `Disconnected from ${gone.url}; its folder stays (${tilde(gone.root)}). ` +
        "Forgetting the computer in the app removes it there.",
    );
    if (!background) return;
    if (state.connections.some((c) => c.id && c.secret)) return await install();
    await uninstallService(service);
    return console.log("Connected to no other app: it no longer runs in the background.");
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
