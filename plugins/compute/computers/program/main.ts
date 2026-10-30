/**
 * The computer program: run it once on a machine to let an app's agents
 * (and people) use it, each space in a folder of its own under its root.
 *
 *   computer connect <app-url> --code <CODE> [--root <dir>] [--name <label>] [--windows <w>]
 *   computer [run] [--root <dir>] [--windows <w>]   run as the computer it was connected as
 *   computer forget                    forget it (its folders stay)
 *
 * `--windows never` (or `COPILOTZ_BROWSER_WINDOWS=never`) keeps agents'
 * browsers hidden: none is ever shown on this screen. `connect` keeps it;
 * `run` can override it, for that run.
 *
 * It runs under `deno run -A`, `node` and `bun`. Ctrl-C (or SIGTERM) stops
 * it, and every shell, job and browser it started.
 */
import process from "node:process";
import { parseArgs } from "node:util";
import { startComputer } from "./computer.ts";
import {
  defaultRoot,
  forgetState,
  loadState,
  rootPath,
  saveState,
  socketUrl,
  statePath,
  windowsSetting,
} from "./state.ts";
import { VERSION } from "./version.ts";

const USAGE = `Copilotz computer ${VERSION}

  computer connect <app-url> --code <CODE> [--root <dir>] [--name <label>] [--windows allow|never]
      Connects this machine to an app with a code from it, then keeps running.
      Spaces' folders go under --root (${defaultRoot()} unless given).
  computer [run] [--root <dir>] [--windows allow|never]
      Runs as the computer it was connected as.
  computer forget
      Forgets it (its id and secret); its folders stay.

Agents' browsers are hidden unless they show one on this screen (to let you
sign in, say). --windows never keeps them hidden, always; connect keeps it,
and run can override it for that run. COPILOTZ_BROWSER_WINDOWS=never does the
same, unless --windows says otherwise.

State: ${statePath()} (COPILOTZ_COMPUTER_STATE puts it elsewhere).`;

/** Runs the computer until a signal stops it (or the app turns it away). */
async function serve(options: Parameters<typeof startComputer>[0]) {
  const computer = await startComputer(options);
  console.log(
    `spaces under ${computer.info.root}; browser: ${computer.info.browser ?? "none found"}` +
      (options.windows === "never" ? " (always hidden: --windows never)" : ""),
  );
  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    await computer.stop();
    process.exit(code);
  };
  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));
  try {
    await computer.closed;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await stop(1);
  }
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
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command = "run", ...rest] = positionals;
  if (values.help || command === "help") return console.log(USAGE);
  if (values.version) return console.log(VERSION);
  const path = statePath();
  // Windows as said here, else in the environment, else as kept.
  const said = windowsSetting(values.windows, "--windows");
  const windows = () =>
    said ??
      windowsSetting(process.env.COPILOTZ_BROWSER_WINDOWS || undefined, "COPILOTZ_BROWSER_WINDOWS");

  if (command === "connect") {
    const [url] = rest;
    if (!url || !values.code) throw new Error("Usage: computer connect <app-url> --code <CODE>");
    socketUrl(url);
    const root = rootPath(values.root ?? defaultRoot());
    // A new enrollment: whatever it was before is replaced once the app answers.
    await saveState({
      url,
      root,
      ...(values.name ? { name: values.name } : {}),
      ...(said ? { windows: said } : {}),
    }, path);
    console.log(`connecting to ${url}…`);
    return await serve({
      url,
      root,
      statePath: path,
      code: values.code,
      ...(values.name ? { name: values.name } : {}),
      windows: windows() ?? "allow",
    });
  }

  if (command === "run") {
    const state = await loadState(path);
    if (!state) {
      throw new Error("Not connected yet: run `computer connect <app-url> --code <CODE>`");
    }
    if (!state.id || !state.secret) {
      throw new Error("Not enrolled: get a new code and run `computer connect` again");
    }
    return await serve({
      url: state.url,
      root: values.root ? rootPath(values.root) : state.root,
      statePath: path,
      ...(state.name ? { name: state.name } : {}),
      windows: windows() ?? state.windows ?? "allow",
    });
  }

  if (command === "forget") {
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
