/**
 * The engines this computer can run: plans' CLIs, each found where it
 * installs, run in a home of its own (`<root>/.copilotz/engines/<name>/`),
 * so its sign-in, settings and sessions are apart from the person's own use
 * of it, with an environment that has no provider's key (a plan's
 * subscription pays, never a key the person keeps for something else).
 *
 * - `claude`: Claude Code, through our adapter (claude.ts), its home its
 *   config dir (`CLAUDE_CONFIG_DIR`, whose sign-in is its own);
 * - `codex`: Codex, through our adapter (codex.ts), its home `CODEX_HOME`;
 * - `antigravity`: `agy acp`, a native ACP agent, its home its `HOME` (it
 *   has no other): its settings there deny every built-in tool. Its sign-in
 *   may be the system keyring's, shared with the person's own.
 * - `grok`: Grok Build, through our adapter (grok.ts), its home its `HOME`
 *   (with `GROK_HOME` in it: Grok reads the person's Claude Code and Cursor
 *   settings from their home too). It signs in with a device code.
 * - `cursor`: a person's Cursor plan, which has no CLI: Cursor's SDK, which
 *   Sign in installs into its home (`npm install`), run by a runner of ours
 *   written beside it (cursor-runner.ts), with Node: an ACP agent itself,
 *   and its own sign-in, status and sign-out. Its home is its `HOME`.
 *
 * A session works in a folder of its own under its engine's home, named by
 * its instructions (so a session loaded later is in the same one), and kept
 * empty: but for a native agent's rules (`AGENTS.md`, its instructions),
 * which it has no prompt of its own to replace with.
 *
 * Signing in is the CLI's own, polled like the terminal (`login`), and so is
 * signing out (`logout`), run in its home: Claude Code's, Codex's and
 * Grok Build's sign-ins are there, so their home goes when it fails. Antigravity has no
 * sign-out of its own here: its sign-in may be the keyring's. The person's
 * own sign-in (`~/.claude`, `~/.codex`) is never touched. Given
 * its official installer (`install`) while the CLI is missing, it runs that
 * first, in the computer's home, then the sign-in: not on Windows, where the
 * person installs it.
 *
 * CLIs are looked for on the `PATH`, then where each installs, in the home
 * the computer's work runs in: a cloud computer's, on its disk, so one
 * installed there is found on its next wake too (see computer.ts's `home`).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import type { EngineStatus, LoginInput, LoginState, LogoutInput } from "../../shared/workloads.ts";
import { fail } from "../workloads/answer.ts";
import { childEnv, homeEnv, OWN, signalGroup, WINDOWS } from "../workloads/processes.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { CURSOR_RUNNER } from "./cursor-runner.ts";
import { grok } from "./grok.ts";
import { agentError, spawnPeer } from "./rpc.ts";
import type { Engine, Peer, Ran } from "./types.ts";
import { writeWhole } from "./write.ts";

/**
 * Never in an engine's environment: providers' credentials, and what would
 * send its calls elsewhere (another cloud's bill, another host given the
 * plan's token) than the plan it's signed in to.
 */
const CREDENTIALS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "XAI_API_KEY",
  "GROK_DEPLOYMENT_KEY",
  "CURSOR_API_KEY",
  "CLAUDECODE",
];

/** Antigravity's settings: none of its own tools (files, commands, the web). */
const DENY_ALL = {
  permissions: {
    deny: [
      "read_file(*)",
      "write_file(*)",
      "command(*)",
      "read_url(*)",
      "execute_url(*)",
      "download_url(*)",
    ],
  },
};

/** Every engine, by name. */
export const ENGINES: Record<string, Engine> = {
  claude: {
    name: "claude",
    binary: "claude",
    places: (user) => [
      join(user, ".local", "bin", "claude"),
      join(user, ".claude", "local", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ],
    homeEnv: (home) => ({ CLAUDE_CONFIG_DIR: home }),
    adapter: claude,
    login: ["auth", "login", "--claudeai"],
    logout: ["auth", "logout"],
    async signedIn(run) {
      const { stdout } = await run(["auth", "status", "--json"]);
      try {
        const said = JSON.parse(stdout) as { loggedIn?: boolean; email?: string };
        return {
          signedIn: said.loggedIn === true,
          ...(said.loggedIn && said.email ? { account: said.email } : {}),
        };
      } catch {
        return { signedIn: false };
      }
    },
  },
  codex: {
    name: "codex",
    binary: "codex",
    places: (user) => [
      join(user, ".local", "bin", "codex"),
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ],
    homeEnv: (home) => ({ CODEX_HOME: home }),
    adapter: codex,
    login: ["login"],
    logout: ["logout"],
    async signedIn(run) {
      const { code, stdout, stderr } = await run(["login", "status"]);
      const said = `${stdout}\n${stderr}`;
      // "Logged in using ChatGPT": a plan. Signed in with an API key isn't (the adapter refuses it).
      return {
        signedIn: code === 0 && /logged in using chatgpt/i.test(said) &&
          !/not logged in/i.test(said),
      };
    },
  },
  antigravity: {
    name: "antigravity",
    binary: "agy",
    places: (user) => [join(user, ".local", "bin", "agy")],
    homeEnv: (home) => ({ HOME: home }),
    // A process per session: needed for MCP servers the client gives over HTTP.
    args: ["acp", "--process-per-session"],
    rules: true,
    prepare: (home) =>
      writeWhole(
        join(home, ".gemini", "antigravity-cli", "settings.json"),
        JSON.stringify(DENY_ALL, null, 2) + "\n",
      ),
    login: ["acp", "--login"],
  },
  grok: {
    name: "grok",
    binary: "grok",
    places: (user) => [join(user, ".grok", "bin", "grok"), join(user, ".local", "bin", "grok")],
    // Its own HOME too: Grok reads the person's Claude Code and Cursor settings from there.
    homeEnv: (home) => ({ HOME: home, GROK_HOME: join(home, ".grok") }),
    adapter: grok,
    // A link and a code, on a cloud computer as on a laptop: nothing to paste back.
    login: ["login", "--device-code"],
    logout: ["logout"],
    async signedIn(run) {
      // "You are logged in with grok.com.", or "You are not authenticated." (its exit is 0 either way).
      const { code, stdout, stderr } = await run(["models"]);
      const said = `${stdout}\n${stderr}`;
      return {
        signedIn: code === 0 && /logged in with/i.test(said) && !/not authenticated/i.test(said),
      };
    },
  },
  cursor: {
    name: "cursor",
    // Cursor has no CLI: its SDK, in its home, run by our runner (cursor-runner.ts), with Node.
    binary: "node",
    places: (
      user,
    ) => [join(user, ".local", "bin", "node"), "/opt/homebrew/bin/node", "/usr/local/bin/node"],
    homeEnv: (home) => ({ HOME: home }),
    args: ["runner.mjs"],
    needs: join("node_modules", "@cursor", "sdk", "package.json"),
    prepare: (home) => writeWhole(join(home, "runner.mjs"), CURSOR_RUNNER),
    version: ["runner.mjs", "version"],
    login: ["runner.mjs", "login"],
    logout: ["runner.mjs", "logout"],
    async signedIn(run) {
      const { stdout } = await run(["runner.mjs", "status"]);
      try {
        const said = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
        return {
          signedIn: said.signedIn === true,
          ...(said.signedIn && said.account ? { account: String(said.account) } : {}),
        };
      } catch {
        return { signedIn: false };
      }
    },
  },
};

/** An engine found on this computer: its CLI, its home, its environment. */
export type Found = { engine: Engine; command: string; home: string; env: Record<string, string> };

/** Whether a file is there and can be run. */
const runnable = (path: string) => access(path, constants.X_OK).then(() => true, () => false);

/** A CLI's output, without terminal escapes (colors, cursor moves). */
const plain = (text: string) =>
  // deno-lint-ignore no-control-regex
  text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]/g, "");

/** The first link a sign-in shows. */
const LINK = /https?:\/\/[^\s"'<>]+/;

/** How long a CLI's own answer (its version, its sign-in) may take. */
const ASKING = 30_000;

/** How long a sign-in may run. */
const SIGNING = 15 * 60_000;

/** How long a login answer waits for more output (a sign-in done sooner answers at once). */
const YIELD = 1_000;

type Login = {
  /** What runs now: its installer, then its sign-in. */
  child: ChildProcess;
  /** What runs once the installer succeeds: its sign-in. */
  then?: () => Promise<ChildProcess>;
  /** What it wrote since the last answer. */
  output: string;
  url?: string;
  done: boolean;
  exited: Promise<void>;
  wake: Set<() => void>;
  timer: ReturnType<typeof setTimeout>;
};

export type EnginesOptions = {
  /** The computer's root: engines' homes are under `.copilotz/engines/`. */
  root: string;
  /** Each engine's CLI, by name: found unless given; null for none. */
  commands?: Record<string, string | null>;
  log: (line: string) => void;
  /**
   * The home the computer's work runs in (homeEnv), when it has one of its
   * own: CLIs are looked for, and installed, there.
   */
  home?: string;
};

export type Engines = {
  /** An engine, found (`missing`, an agent's failure, when it isn't installed). */
  find(name: string): Promise<Found>;
  /** Starts it: a peer speaking ACP (an adapter of ours, or its own process). */
  launch(found: Found): Peer;
  /** A session's folder: named by its instructions, with them as rules for a native agent. */
  folder(found: Found, instructions: string): Promise<string>;
  status(names?: string[]): Promise<EngineStatus[]>;
  login(input: LoginInput): Promise<LoginState>;
  /**
   * Signs it out, in its home only: a sign-in under way stops, then its
   * CLI's own sign-out runs (its home goes when that fails). One without a
   * sign-out of its own fails (`unsupported`), saying what to do.
   */
  logout(input: LogoutInput): Promise<void>;
  /** Stops every sign-in under way. */
  stop(): Promise<void>;
};

/** The engines of the computer at `root`. */
export function createEngines(options: EnginesOptions): Engines {
  const user = options.home ?? homedir();
  const base = options.home ? homeEnv(options.home) : undefined;
  const logins = new Map<string, Login>();

  /** The computer's environment, without any provider's credentials. */
  const cleanEnv = () => {
    const env = childEnv(base);
    for (const key of CREDENTIALS) delete env[key];
    return env;
  };

  /** An engine's own home on this computer. */
  const homeOf = (name: string) => join(options.root, ".copilotz", "engines", name);

  const engineOf = (name: unknown): Engine => {
    if (typeof name !== "string" || !Object.hasOwn(ENGINES, name)) {
      fail(`Unknown engine "${name}": ${Object.keys(ENGINES).join(", ")}`);
    }
    return ENGINES[name];
  };

  /** Its CLI: as given, else on the PATH, else where it installs. */
  const commandOf = async (engine: Engine): Promise<string | undefined> => {
    const given = options.commands?.[engine.name];
    if (given !== undefined) return given ?? undefined;
    const name = WINDOWS ? `${engine.binary}.exe` : engine.binary;
    const path = base?.PATH ?? process.env.PATH ?? process.env.Path ?? "";
    for (const dir of path.split(delimiter).filter(Boolean)) {
      if (await runnable(join(dir, name))) return join(dir, name);
    }
    for (const place of engine.places(user)) if (await runnable(place)) return place;
  };

  const find = async (name: string): Promise<Found> => {
    const engine = engineOf(name);
    const command = await commandOf(engine);
    if (!command) throw agentError("missing", `${engine.binary} isn't installed on this computer`);
    const home = homeOf(engine.name);
    await mkdir(home, { recursive: true, mode: 0o700 });
    if (engine.needs && !await access(join(home, engine.needs)).then(() => true, () => false)) {
      throw agentError("missing", `${engine.name} isn't installed on this computer`);
    }
    await engine.prepare?.(home);
    return { engine, command, home, env: { ...cleanEnv(), ...engine.homeEnv(home) } };
  };

  /** Runs its CLI with `args` (and `stdin`) in its home, for at most `ASKING`. */
  const run = (found: Found, args: string[], stdin?: string) =>
    new Promise<Ran>((resolve) => {
      const child = spawn(found.command, args, {
        cwd: found.home,
        env: found.env,
        stdio: ["pipe", "pipe", "pipe"],
        ...OWN,
      });
      let stdout = "";
      let stderr = "";
      child.stdout!.setEncoding("utf8").on("data", (text: string) => stdout += text);
      child.stderr!.setEncoding("utf8").on("data", (text: string) => stderr += text);
      child.stdin!.on("error", () => {});
      child.stdin!.end(stdin);
      const timer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), ASKING);
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: error.message });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout: plain(stdout), stderr: plain(stderr) });
      });
    });

  const launch = (found: Found): Peer => {
    const log = (line: string) => options.log(`${found.engine.name}: ${line}`);
    if (found.engine.adapter) {
      return found.engine.adapter({
        command: found.command,
        home: found.home,
        env: found.env,
        log,
      });
    }
    return spawnPeer(found.command, found.engine.args ?? [], {
      cwd: found.home,
      env: found.env,
      log,
    });
  };

  const folder = async (found: Found, instructions: string) => {
    const key = createHash("sha256").update(instructions).digest("hex").slice(0, 32);
    const dir = join(found.home, "work", key);
    await mkdir(dir, { recursive: true });
    if (found.engine.rules) await writeWhole(join(dir, "AGENTS.md"), instructions);
    return dir;
  };

  /** Whether a native agent is signed in: whether it starts a session. */
  const probe = async (found: Found): Promise<boolean> => {
    const peer = launch(found);
    const timer = setTimeout(() => void peer.close(), ASKING);
    try {
      const cwd = join(found.home, "work", "probe");
      await mkdir(cwd, { recursive: true });
      await peer.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      await peer.request("session/new", { cwd, mcpServers: [] });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      await peer.close();
    }
  };

  const signedIn = (found: Found) =>
    found.engine.signedIn
      ? found.engine.signedIn((args, stdin) => run(found, args, stdin))
      : probe(found).then((signedIn) => ({ signedIn }));

  const statusOf = async (name: string): Promise<EngineStatus> => {
    let found: Found;
    try {
      found = await find(name);
    } catch {
      return { engine: name, installed: false, signedIn: false };
    }
    const [ran, signed] = await Promise.all([
      run(found, found.engine.version ?? ["--version"]),
      signedIn(found).catch(() => ({ signedIn: false })),
    ]);
    const line = `${ran.stdout}\n${ran.stderr}`.trim().split("\n")[0] ?? "";
    const version = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(line)?.[0];
    return { engine: name, installed: true, ...(version ? { version } : {}), ...signed };
  };

  /** Until the sign-in writes more, ends, or `ms` pass. */
  const settle = (login: Login, ms: number) =>
    new Promise<void>((resolve) => {
      if (login.done) return resolve();
      const done = () => {
        clearTimeout(timer);
        login.wake.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      login.wake.add(done);
    });

  /** Its CLI's own sign-in. */
  const signIn = (found: Found) =>
    spawn(found.command, found.engine.login, {
      cwd: found.home,
      env: found.env,
      stdio: ["pipe", "pipe", "pipe"],
      ...OWN,
    });

  /**
   * Its official installer, in the computer's home, told the engine's own
   * (`ENGINE_HOME`: Cursor's SDK goes there). Nothing to answer: it reads no input.
   */
  const installer = (command: string, engine: string) =>
    spawn("/bin/sh", ["-c", command], {
      cwd: user,
      env: { ...cleanEnv(), ENGINE_HOME: homeOf(engine) },
      stdio: ["ignore", "pipe", "pipe"],
      ...OWN,
    });

  /** A sign-in under way: `first`, then (when it succeeds) what `then` starts, as one output. */
  const startLogin = (first: ChildProcess, then?: () => Promise<ChildProcess>): Login => {
    let ended!: () => void;
    const login: Login = {
      child: first,
      then,
      output: "",
      done: false,
      exited: new Promise<void>((resolve) => ended = resolve),
      wake: new Set(),
      timer: setTimeout(() => signalGroup(login.child.pid, "SIGTERM"), SIGNING),
    };
    const end = () => {
      if (login.done) return;
      login.done = true;
      clearTimeout(login.timer);
      for (const wake of [...login.wake]) wake();
      ended();
    };
    /** Follows `child`: its sign-in link is looked for only in the sign-in's own output. */
    const follow = (child: ChildProcess, signing: boolean) => {
      login.child = child;
      let said = "";
      const heard = (text: string) => {
        login.output = (login.output + plain(text)).slice(-64 * 1024);
        if (!signing || login.url) return;
        said = (said + plain(text)).slice(-64 * 1024);
        login.url = LINK.exec(said)?.[0];
      };
      child.stdout!.setEncoding("utf8").on("data", heard);
      child.stderr!.setEncoding("utf8").on("data", heard);
      child.stdin?.on("error", () => {});
      child.once("error", (error) => {
        heard(`${error.message}\n`);
        end();
      });
      child.once("close", (code) => {
        const next = login.then;
        login.then = undefined;
        if (code !== 0 || !next) return end();
        next().then((child) => follow(child, true), (error) => {
          heard(`${error instanceof Error ? error.message : error}\n`);
          end();
        });
      });
    };
    follow(first, !then);
    return login;
  };

  const stopLogin = async (login: Login) => {
    login.then = undefined;
    if (!login.done) {
      signalGroup(login.child.pid, "SIGTERM");
      const timer = setTimeout(() => signalGroup(login.child.pid, "SIGKILL"), 2_000);
      await login.exited;
      clearTimeout(timer);
    }
  };

  return {
    find,
    launch,
    folder,
    status: (names) => Promise.all((names ?? Object.keys(ENGINES)).map(statusOf)),
    async login(input) {
      const engine = engineOf(input?.engine).name;
      if (input.input !== undefined && typeof input.input !== "string") fail("input is text");
      if (input.install !== undefined && typeof input.install !== "string") {
        fail("install is a command");
      }
      const install = WINDOWS ? undefined : input.install;
      let login = logins.get(engine);
      if (input.stop) {
        if (login) await stopLogin(login);
      } else if (!login) {
        if (input.input) fail("No sign-in is under way: start one first", "not_found");
        // Missing, it's installed first when it may be.
        const found = await find(engine)
          .catch((error) => install ? undefined : fail(error.message, "missing"));
        login = found
          ? startLogin(signIn(found))
          : startLogin(installer(install!, engine), () => find(engine).then(signIn));
        logins.set(engine, login);
      } else if (input.input && !login.done) {
        login.child.stdin?.write(input.input.endsWith("\n") ? input.input : `${input.input}\n`);
      }
      if (login && !login.done && !input.stop) await settle(login, YIELD);
      const output = login?.output ?? "";
      if (login) login.output = "";
      if (login && !login.done) {
        return {
          state: "running",
          output,
          signedIn: false,
          ...(login.url ? { url: login.url } : {}),
        };
      }
      logins.delete(engine);
      const found = await find(engine).catch(() => undefined);
      const signed = found ? await signedIn(found).catch(() => ({ signedIn: false })) : undefined;
      return {
        state: "done",
        output,
        signedIn: signed?.signedIn ?? false,
        ...(login?.url ? { url: login.url } : {}),
      };
    },
    async logout(input) {
      const engine = engineOf(input?.engine);
      if (!engine.logout) {
        fail(
          `${engine.binary} can't be signed out from here: its sign-in may be in the system's ` +
            `keyring, beside your own use of it. Sign out in ${engine.binary} on the computer itself.`,
          "unsupported",
        );
      }
      const login = logins.get(engine.name);
      logins.delete(engine.name);
      if (login) await stopLogin(login);
      const found = await find(engine.name).catch(() => undefined);
      const ran = found ? await run(found, engine.logout) : undefined;
      if (ran?.code !== 0) {
        await rm(join(options.root, ".copilotz", "engines", engine.name), {
          recursive: true,
          force: true,
        });
      }
    },
    async stop() {
      await Promise.all([...logins.values()].map(stopLogin));
      logins.clear();
    },
  };
}
