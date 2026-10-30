/**
 * `computer.archive`: a folder of a space (`path`, or the space's folder
 * itself) as a gzipped tar, streamed out as the system's `tar` makes it
 * (GNU tar, or bsdtar on macOS and Windows), its paths relative to that
 * folder (`./…`). Dependency and build caches (`.git`, `node_modules`…) are
 * left out unless `all`.
 *
 * Input it can't take (a path out of the space's folder, one that isn't
 * there) answers its failure (`Failed`, as JSON) instead of an archive: what
 * starts `{`, not gzip's `1f 8b`. Past `maxBytes` (512 MiB unless given), or
 * when `tar` fails, the archive stops with an error (`too_large`, or
 * `failed`) rather than ending.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { WorkerWorkHandler } from "@oxian/oxian-js";
import type { ArchiveInput } from "../../shared/workloads.ts";
import { fail, failure } from "./answer.ts";
import { existing, segments } from "./files.ts";
import { childEnv } from "./processes.ts";
import type { Spaces } from "./spaces.ts";

/** What's left out unless `all`: dependencies, builds, caches, and the repository itself. */
export const LEFT_OUT = [
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".turbo",
];

/** The most an archive is unless asked otherwise. */
const MOST = 512 * 1024 * 1024;

const encoder = new TextEncoder();

/** An error the archive stops with, its code in its message too (all a stream's error carries). */
const stopped = (message: string, code: string) =>
  Object.assign(new Error(`${message} (${code})`), { code });

/** `computer.archive`, for the spaces of this computer. */
export function createArchive(spaces: Spaces): WorkerWorkHandler {
  return async ({ input, signal }) => {
    let dir: string;
    let most: number;
    let all: boolean;
    try {
      const text = await new Response(input).text();
      const request = (text ? JSON.parse(text) : {}) as ArchiveInput;
      const folder = await spaces.folder(request.scope);
      const parts = segments(request.path, true);
      dir = await existing(folder, parts, parts.join("/") || ".");
      if (!(await stat(dir)).isDirectory()) fail(`${parts.join("/")} isn't a folder`);
      most = request.maxBytes ?? MOST;
      if (!Number.isInteger(most) || most < 1) fail("maxBytes must be a whole number ≥ 1");
      all = request.all === true;
    } catch (error) {
      return encoder.encode(JSON.stringify(failure(error)));
    }

    const args = [
      "-czf",
      "-",
      ...(all ? [] : LEFT_OUT.flatMap((name) => ["--exclude", name])),
      "-C",
      dir,
      ".",
    ];
    // macOS's tar would add its files' extended attributes, as `._` entries of their own.
    const child = spawn("tar", args, {
      env: { ...childEnv(), COPYFILE_DISABLE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      const missing = (error as { code?: string })?.code === "ENOENT";
      return encoder.encode(JSON.stringify(failure(
        missing ? Object.assign(new Error("This computer has no tar"), { code: "failed" }) : error,
      )));
    }
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (text: string) => stderr = (stderr + text).slice(-4096));
    const halt = () => child.kill("SIGKILL");
    signal.addEventListener("abort", halt, { once: true });

    let sent = 0;
    let over = false;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        child.stdout!.on("data", (chunk: Uint8Array) => {
          if (over) return;
          sent += chunk.length;
          if (sent > most) {
            over = true;
            halt();
            return controller.error(
              stopped(
                `The archive is larger than ${most} bytes: give a smaller folder`,
                "too_large",
              ),
            );
          }
          controller.enqueue(new Uint8Array(chunk));
          if ((controller.desiredSize ?? 1) <= 0) child.stdout!.pause();
        });
        child.on("close", (code) => {
          signal.removeEventListener("abort", halt);
          if (over) return;
          if (signal.aborted) {
            return controller.error(stopped("The archive was cancelled", "failed"));
          }
          if (code === 0) return controller.close();
          controller.error(
            stopped(`tar failed (${code}): ${stderr.trim().split("\n").pop() ?? ""}`, "failed"),
          );
        });
      },
      pull() {
        child.stdout!.resume();
      },
      cancel() {
        over = true;
        halt();
      },
    }, { highWaterMark: 4 });
  };
}
