/**
 * A local app host, for development and tests: a stand-in for Cloud Run on
 * this machine, isolating nothing (never for apps people publish for real).
 *
 * - **build** extracts the archive into a folder of its own (a temporary
 *   one), which is the "image"; the command is kept with it.
 * - **deploy** runs the command there, with `PORT` set to a free port (as
 *   Cloud Run sets it), and answers once that port takes connections; or,
 *   with `target`, runs nothing and answers that address.
 * - **remove** stops what runs and deletes its folders. `close` does it for
 *   every app.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import type { AppHost } from "../contract.ts";
import { entries } from "./tar.ts";

export type LocalHost = AppHost & {
  /** Each app's folder now (its latest build). */
  folders: Map<string, string>;
  close(): Promise<void>;
};

export type LocalHostOptions = {
  /** Where builds go (a temporary folder by default). */
  dir?: string;
  /** Run nothing: every deploy answers this address. */
  target?: string;
  /** How long a deployed command may take to listen (15 s). */
  startMs?: number;
};

/** A free TCP port on the loopback. */
const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

/** Whether something listens on the port. */
const listening = (port: number) =>
  new Promise<boolean>((done) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => (socket.destroy(), done(true)));
    socket.once("error", () => done(false));
  });

/** Extracts a gzipped tar into `dir`: files and folders, never outside it. */
async function extract(archive: ReadableStream<Uint8Array>, dir: string) {
  const root = resolve(dir);
  for await (const entry of entries(archive, { want: () => true })) {
    const path = resolve(root, entry.name);
    if (!path.startsWith(root + sep) || entry.name.split("/").includes("..")) continue;
    if (entry.type === "directory") await mkdir(path, { recursive: true });
    else if (entry.type === "file") {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entry.body ?? new Uint8Array());
      if (entry.mode & 0o111) await chmod(path, entry.mode & 0o777);
    }
  }
}

/** Stops a command and what it started (its process group, where there is one). */
function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill();
  } catch {
    child.kill();
  }
}

export function localHost(options: LocalHostOptions = {}): LocalHost {
  const built = new Map<string, { app: string; command?: string }>();
  const folders = new Map<string, string>();
  const made = new Map<string, string[]>();
  const running = new Map<string, ChildProcess>();
  let revisions = 0;

  const removing = async (app: string) => {
    const child = running.get(app);
    if (child) stop(child), running.delete(app);
    for (const dir of made.get(app) ?? []) await rm(dir, { recursive: true, force: true });
    made.delete(app);
    folders.delete(app);
  };

  return {
    folders,
    async build({ app, archive, command }) {
      const started = Date.now();
      const base = options.dir ?? tmpdir();
      await mkdir(base, { recursive: true });
      const dir = await mkdtemp(join(base, `cz-app-${app.replace(/[^\w-]/g, "")}-`));
      made.set(app, [...made.get(app) ?? [], dir]);
      await extract(archive, dir);
      built.set(dir, { app, ...(command ? { command } : {}) });
      folders.set(app, dir);
      return { image: dir, minutes: (Date.now() - started) / 60_000 };
    },

    async deploy({ app, image, env }) {
      const revision = `${app}-${String(++revisions).padStart(5, "0")}`;
      if (options.target) return { service: `local/${app}`, target: options.target, revision };
      const command = built.get(image)?.command;
      if (!command) {
        throw new Error(
          "The local app host runs the app's command: publish it from a job (or give it a target).",
        );
      }
      const old = running.get(app);
      if (old) stop(old);
      const port = await freePort();
      const child = spawn(command, {
        cwd: image,
        shell: true,
        detached: process.platform !== "win32",
        stdio: "ignore",
        env: { ...process.env, ...env, PORT: String(port) },
      });
      running.set(app, child);
      const exited = new Promise<void>((done) => {
        child.once("exit", () => done());
        child.once("error", () => done());
      });
      const until = Date.now() + (options.startMs ?? 15_000);
      for (;;) {
        if (await listening(port)) break;
        const gone = await Promise.race([exited.then(() => true), sleep(100).then(() => false)]);
        if (gone) throw new Error(`The app's command (${command}) stopped before it listened.`);
        if (Date.now() > until) {
          stop(child);
          throw new Error(`The app's command (${command}) didn't listen on PORT in time.`);
        }
      }
      return { service: `local/${app}`, target: `http://127.0.0.1:${port}`, revision };
    },

    remove: (app) => removing(app),

    async close() {
      for (const app of new Set([...made.keys(), ...running.keys()])) await removing(app);
    },
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
