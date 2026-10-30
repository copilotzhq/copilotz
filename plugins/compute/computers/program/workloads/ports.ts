/**
 * The TCP ports jobs listen on, found as they run, best effort: each job's
 * process tree (what it leads: its process group, and what descends from
 * it), and what listens on this machine, by process. `/proc` and `ss` on
 * Linux, `ps` and `lsof` on macOS, PowerShell and `netstat` on Windows. A
 * tool that's missing (or fails) finds nothing: undefined, not "none".
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import { WINDOWS } from "./processes.ts";

/**
 * A tool's output: what it wrote, even when it ended unhappy (lsof finding
 * nothing); undefined when it's missing, or failed to run.
 */
function output(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          return resolve(undefined);
        }
        resolve(String(stdout));
      },
    );
  });
}

/** A port from an address as tools write it (`*:3000`, `[::1]:3000`, `0.0.0.0:3000`). */
const portOf = (address: string) => {
  const port = Number(address.slice(address.lastIndexOf(":") + 1));
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
};

type Row = { pid: number; parent: number; group?: number };

/** Linux's processes, as `/proc` has them (no `ps` needed): `pid (name) state ppid pgrp …`. */
async function linuxProcesses(): Promise<Row[] | undefined> {
  const names = await readdir("/proc").catch(() => undefined);
  if (!names) return undefined;
  const rows = await Promise.all(
    names.filter((name) => /^\d+$/.test(name)).map(async (name) => {
      const stat = await readFile(`/proc/${name}/stat`, "utf8").catch(() => "");
      // Its name may hold spaces and parentheses: what follows the last ")" is plain.
      const [, parent, group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ").map(Number);
      return Number.isInteger(parent) && Number.isInteger(group)
        ? [{ pid: Number(name), parent, group }]
        : [];
    }),
  );
  return rows.flat();
}

/** Every process: its parent, and its process group (not on Windows). */
async function processes(): Promise<Row[] | undefined> {
  if (process.platform === "linux") return await linuxProcesses();
  const text = WINDOWS
    ? await output("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
    ])
    : await output("ps", ["-axo", "pid=,ppid=,pgid="]);
  if (text === undefined) return undefined;
  return text.trim().split("\n").flatMap((line) => {
    const [pid, parent, group] = line.trim().split(/\s+/).map(Number);
    return Number.isInteger(pid) && Number.isInteger(parent)
      ? [{ pid, parent, ...(Number.isInteger(group) ? { group } : {}) }]
      : [];
  });
}

/** Each of `leaders`' trees: who leads each process found in one. */
function trees(rows: Row[], leaders: number[]): Map<number, number> {
  const leader = new Map<number, number>();
  for (const pid of leaders) leader.set(pid, pid);
  for (const row of rows) {
    if (row.group !== undefined && leader.has(row.group) && !leader.has(row.pid)) {
      leader.set(row.pid, leader.get(row.group)!);
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (leader.has(row.parent) && !leader.has(row.pid)) {
        leader.set(row.pid, leader.get(row.parent)!);
        changed = true;
      }
    }
  }
  return leader;
}

/** What listens, by process, among `pids` (on Linux and Windows, what lists every one). */
async function listening(pids: number[]): Promise<[number, number][] | undefined> {
  if (process.platform === "linux") {
    const text = await output("ss", ["-ltnpH"]);
    if (text === undefined) return undefined;
    return text.split("\n").flatMap((line) => {
      const port = portOf(line.trim().split(/\s+/)[3] ?? "");
      if (!port) return [];
      return [...line.matchAll(/pid=(\d+)/g)].map((m) => [Number(m[1]), port] as [number, number]);
    });
  }
  if (process.platform === "darwin") {
    const text = await output("lsof", [
      "-nP",
      "-iTCP",
      "-sTCP:LISTEN",
      "-a",
      "-p",
      pids.join(","),
      "-Fpn",
    ]);
    if (text === undefined) return undefined;
    const found: [number, number][] = [];
    let pid = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n")) {
        const port = portOf(line.slice(1));
        if (port && pid) found.push([pid, port]);
      }
    }
    return found;
  }
  if (WINDOWS) {
    const text = await output("netstat.exe", ["-ano", "-p", "TCP"]);
    if (text === undefined) return undefined;
    return text.split("\n").flatMap((line) => {
      const [, local, , state, pid] = line.trim().split(/\s+/);
      const port = portOf(local ?? "");
      return state === "LISTENING" && port ? [[Number(pid), port] as [number, number]] : [];
    });
  }
  return undefined;
}

/**
 * The ports each of `leaders` (jobs' processes) and what it started listen
 * on now, sorted; undefined when it can't be found here.
 */
export async function portsOf(leaders: number[]): Promise<Map<number, number[]> | undefined> {
  if (!leaders.length) return new Map();
  const rows = await processes();
  if (!rows) return undefined;
  const leader = trees(rows, leaders);
  const found = await listening([...leader.keys()]);
  if (!found) return undefined;
  const ports = new Map<number, Set<number>>(leaders.map((pid) => [pid, new Set()]));
  for (const [pid, port] of found) {
    const of = leader.get(pid);
    if (of !== undefined) ports.get(of)!.add(port);
  }
  return new Map([...ports].map(([pid, set]) => [pid, [...set].sort((a, b) => a - b)]));
}
