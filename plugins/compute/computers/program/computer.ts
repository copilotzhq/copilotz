/**
 * A computer: this machine, connected to an app as an Oxian worker of the
 * `computer` kind, serving its work (shells, jobs, files, a browser, a web
 * search) in a folder per space under its root, apart per who.
 *
 * It enrolls with a one-time code (`computer:code:<CODE>`); the app answers
 * with `computer.enrolled`, its id and secret, which it keeps; from then on
 * it connects as itself (`computer:<id>.<secret>`). Oxian carries it across
 * dropped connections; when the app forgets that session (it restarted), it
 * connects again as itself, with the same attempt identity. It asks the app
 * for nothing. Built (not run from source), it also takes newer versions
 * the app offers (`UPDATE`): it updates itself (update.ts) and stops, to be
 * started again as it.
 */
import { createWorker, type Worker } from "@oxian/oxian-js";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import process from "node:process";
import { type Enrolled, type Info, WORK } from "../shared/workloads.ts";
import { createBrowsers, findChrome, type Windows } from "./browser/mod.ts";
import { newer, type Offer, UPDATE } from "./release.ts";
import { loadState, saveState, socketUrl } from "./state.ts";
import { checkOffer, PROGRAM, updateProgram } from "./update.ts";
import { VERSION } from "./version.ts";
import { answer, fail } from "./workloads/answer.ts";
import { createBrowserWork } from "./workloads/browser.ts";
import { createFiles } from "./workloads/files.ts";
import { machineInfo } from "./workloads/info.ts";
import { createJobs } from "./workloads/jobs.ts";
import { createSpaces } from "./workloads/spaces.ts";
import { childEnv } from "./workloads/processes.ts";
import { search } from "./workloads/search.ts";
import { findShell, type Shell } from "./workloads/shell.ts";
import { createShells, type ShellLimits } from "./workloads/terminal.ts";

export type ComputerOptions = {
  /** The app's URL (`http(s)://host`), or its socket (`ws(s)://…`). */
  url: string;
  /** Where spaces' folders go. */
  root: string;
  /** Where its id and secret are kept (state.ts). */
  statePath: string;
  /** A one-time code to enroll with, while it has no id and secret. */
  code?: string;
  /** What it's called, as `computer.info` says. */
  name?: string;
  /** The Chrome to drive: found unless given; null for none. */
  chromium?: string | null;
  /** The shell its terminal and jobs run: this computer's (shell.ts) unless given. */
  shell?: Shell;
  /**
   * The executable an update replaces: this program's own when it runs as
   * one, unless given; null for none (run from source, it isn't updated).
   */
  program?: string | null;
  /** Whether agents may show a browser window on this screen ("never": always hidden). */
  windows?: Windows;
  /** Where searches go (DuckDuckGo's HTML page unless set, or `COPILOTZ_SEARCH_URL`). */
  searchUrl?: string;
  shells?: ShellLimits;
  /** How long a job gets to stop after SIGTERM. */
  jobStopGraceMs?: number;
  /** Who's browser, unused this long, stops (its profile stays). */
  browserIdleMs?: number;
  /** Where its concise log lines go (never a secret). */
  log?: (line: string) => void;
};

export type Computer = {
  /** When it's first connected and admitted. */
  ready: Promise<void>;
  /** When it has its id and secret: at once if it had them, else once the app enrolls it. */
  enrolled: Promise<void>;
  /**
   * When it's stopped: `updated` when it stopped to be started again as a
   * newer version (installed). It fails when the app turns it away.
   */
  closed: Promise<"stopped" | "updated">;
  info: Info;
  /** Disconnects, and stops every shell, job and browser it started. */
  stop(): Promise<void>;
};

/** Turned away by the app: the code or the computer isn't (or is no longer) known. */
export type Refused = Error & { code: "refused" };

/** Waits `ms`, or until `signal` aborts. */
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/** Starts a computer: its spaces, its work, and its connection to the app. */
export async function startComputer(options: ComputerOptions): Promise<Computer> {
  const log = options.log ?? ((line: string) => console.log(line));
  const url = socketUrl(options.url);
  await mkdir(options.root, { recursive: true });
  const root = await realpath(options.root);
  const chromium = options.chromium === undefined ? await findChrome() : options.chromium;
  const shell = options.shell ?? await findShell();
  const program = options.program === undefined ? PROGRAM : options.program;
  const searchUrl = options.searchUrl ?? process.env.COPILOTZ_SEARCH_URL;

  const spaces = createSpaces(root);
  const shells = createShells(spaces, shell, options.shells);
  const jobs = createJobs(spaces, shell, { stopGraceMs: options.jobStopGraceMs });
  const files = createFiles(spaces);
  const browsers = createBrowsers({
    root,
    chromium,
    windows: options.windows,
    searchUrl,
    env: childEnv(),
    idleMs: options.browserIdleMs,
  });
  const browser = createBrowserWork(browsers, spaces);
  const info = machineInfo(root, shell, chromium, options.name, options.windows);
  const halt = new AbortController();
  let reason: "stopped" | "updated" = "stopped";
  let enrolledNow!: () => void;
  let unenrolled!: (error: unknown) => void;
  const enrolled = new Promise<void>((resolve, reject) => {
    enrolledNow = resolve;
    unenrolled = reject;
  });
  enrolled.catch(() => {});
  const known = await loadState(options.statePath);
  if (known?.id && known.secret) enrolledNow();

  /** Updates `program` to what the app offers, when it's newer, then stops, to start again as it. */
  let updating: string | undefined;
  const update = (program: string) => (input: unknown) => {
    const offer: Offer = checkOffer(input, options.url);
    if (updating || !newer(offer.version, VERSION)) return { updating: !!updating };
    updating = offer.version;
    log(`updating to ${offer.version}…`);
    void updateProgram(program, offer, halt.signal).then(() => {
      log(`updated to ${offer.version}; starting again`);
      reason = "updated";
      return computer.stop();
    }, (error) => {
      updating = undefined;
      if (!halt.signal.aborted) {
        log(
          `couldn't update to ${offer.version}: ${error instanceof Error ? error.message : error}`,
        );
      }
    });
    return { updating: true };
  };

  const workloads = {
    [WORK.enrolled]: answer(async (input: Enrolled) => {
      if (typeof input?.id !== "string" || !input.id || typeof input.secret !== "string") {
        fail("enrolled needs an id and a secret");
      }
      const state = await loadState(options.statePath);
      // What `connect` kept (its name, its windows) stays.
      await saveState({
        ...(options.name ? { name: options.name } : {}),
        ...state,
        url: state?.url ?? options.url,
        root: state?.root ?? options.root,
        id: input.id,
        secret: input.secret,
      }, options.statePath);
      log(`enrolled as ${input.id}`);
      enrolledNow();
      return { ok: true };
    }),
    [WORK.info]: answer(() => info),
    // Run from source, there's nothing to update: it doesn't take the work.
    ...(program ? { [UPDATE]: answer(update(program)) } : {}),
    [WORK.terminal]: answer(shells.submit),
    [WORK.jobsStart]: answer(jobs.start),
    [WORK.jobsList]: answer(jobs.list),
    [WORK.jobsLogs]: answer(jobs.logs),
    [WORK.jobsStop]: answer(jobs.stop),
    [WORK.filesList]: answer(files.list),
    [WORK.filesRead]: answer(files.read),
    [WORK.filesWrite]: answer(files.write),
    [WORK.filesEdit]: answer(files.edit),
    [WORK.browser]: answer(browser.run),
    [WORK.search]: answer((input: Parameters<typeof search>[0], signal) =>
      search(input, { url: searchUrl, browser: browser.search, signal })
    ),
  };

  // One attempt per process, kept across reconnects, so Oxian can fence a replaced one.
  const attempt = { attemptId: randomUUID(), epoch: Date.now() };
  const workerId = `computer-${randomUUID()}`;
  let stopping = false;
  let current: Worker | undefined;
  let connected = false;
  let readied!: () => void;
  let unready!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readied = resolve;
    unready = reject;
  });
  ready.catch(() => {});

  /**
   * Logs how the connection goes: connected, lost, back. Not reaching the app
   * at first is said only once it's lasted a moment: a refused code passes
   * through reconnecting too, and says so itself.
   */
  const watch = async (worker: Worker) => {
    const reader = worker.events.getReader();
    let was = "";
    let unreachable: ReturnType<typeof setTimeout> | false | undefined;
    const quiet = () => unreachable && clearTimeout(unreachable);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        if (value.type !== "state") continue;
        const state = value.snapshot.state;
        if (state === "ready" && was !== "ready") {
          quiet();
          log(connected ? "connected again" : `connected to ${url}`);
          connected = true;
        } else if (state === "reconnecting" && was === "ready") {
          log("connection lost; reconnecting…");
        } else if (state === "reconnecting" && !connected && unreachable === undefined) {
          unreachable = setTimeout(() => {
            if (!connected && !stopping) log(`can't reach ${url} yet; retrying…`);
            unreachable = false;
          }, 2_000);
        }
        was = state;
      }
    } catch {
      // The worker went.
    } finally {
      quiet();
    }
  };

  const closed = (async () => {
    for (let failures = 0; !stopping;) {
      let presented: "code" | "secret" = "code";
      let admitted = false;
      const worker = current = createWorker({
        id: workerId,
        transport: { type: "websocket", config: { url, allowInsecureLoopback: true } },
        activate: ({ workerId }) => ({ identity: { workerId, ...attempt } }),
        // Who it is, as the state says now: itself once enrolled, its code before.
        register: async () => {
          const state = await loadState(options.statePath);
          const capability = state?.id && state.secret
            ? `computer:${state.id}.${state.secret}`
            : options.code
            ? `computer:code:${options.code}`
            : fail("Not enrolled: run `connect <app-url> --code <CODE>`", "refused");
          presented = capability.startsWith("computer:code:") ? "code" : "secret";
          return {
            credential: { kind: "registration", capability },
            expiresAtMs: Date.now() + 60_000,
          };
        },
        capacity: 256,
        workloads,
      });
      void watch(worker);
      worker.ready.then(() => {
        admitted = true;
        failures = 0;
        readied();
      }, () => {});
      try {
        const result = await worker.closed;
        if (stopping) break;
        // The app forgot this session (it restarted): connect again as itself, now.
        if (result.reason === "reenrollment_required") continue;
        log("disconnected; reconnecting…");
      } catch (error) {
        if (stopping) break;
        const code = (error as { code?: string })?.code;
        if (!admitted && (code === "credential_rejected" || code === "refused")) {
          const refused = Object.assign(
            new Error(
              code === "refused"
                ? (error as Error).message
                : presented === "code"
                ? "The app didn't take that code (it may have expired, or been used): get a new one and run `connect` again"
                : "The app doesn't know this computer anymore: get a new code and run `connect` again",
            ),
            { code: "refused" as const },
          );
          unready(refused);
          unenrolled(refused);
          throw refused;
        }
        log(`connection failed (${error instanceof Error ? error.message : error}); retrying…`);
      }
      await wait(Math.min(30_000, 500 * 2 ** failures++), halt.signal);
    }
    return reason;
  })();
  closed.catch(() => {});

  let stopped: Promise<void> | undefined;
  const computer: Computer = {
    ready,
    enrolled,
    closed,
    info,
    stop() {
      return stopped ??= (async () => {
        stopping = true;
        halt.abort();
        unready(new Error("The computer stopped"));
        unenrolled(new Error("The computer stopped"));
        await current?.stop().catch(() => {});
        await closed.catch(() => {});
        await Promise.allSettled([shells.stopAll(), jobs.stopAll(), browsers.close()]);
      })();
    },
  };
  return computer;
}
