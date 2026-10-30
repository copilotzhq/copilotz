/**
 * The program updating itself, when the app offers a newer version
 * (`computer.update`: its version, and this platform's binary's URL, size
 * and SHA-256, said by the app over its own connection). It fetches the
 * binary beside itself, checks its size and hash, and that it runs and says
 * that version; only then swaps it in: a rename, atomic, or on Windows, where
 * a running program can't be replaced, after renaming itself aside (the next
 * start removes what it can of those). A file that doesn't check is removed,
 * never run as the program. Then the program starts again, as the new one
 * (see main.ts).
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import type { Offer } from "./release.ts";
import { WINDOWS } from "./workloads/processes.ts";

/** The program's own executable when it runs as one (built), not as a script of deno, node or bun. */
export const PROGRAM: string | undefined =
  ["deno", "node", "bun"].includes(basename(process.execPath).toLowerCase().replace(/\.exe$/, ""))
    ? undefined
    : process.execPath;

const fail = (message: string): never => {
  throw Object.assign(new Error(message), { code: "invalid" });
};

/**
 * An offer as the app sent it, checked, its URL resolved against the app's
 * (`app`: its http(s) URL, or its socket's).
 */
export function checkOffer(value: unknown, app: string): Offer {
  const offer = value as Partial<Offer> | undefined;
  if (
    typeof offer?.version !== "string" || typeof offer.url !== "string" ||
    !Number.isSafeInteger(offer.size) || !/^[0-9a-f]{64}$/i.test(offer.sha256 ?? "")
  ) fail("An update is a version, a URL, a size and a SHA-256");
  const url = new URL(offer!.url!, app.replace(/^ws(s?):/, "http$1:"));
  if (url.protocol !== "https:" && url.protocol !== "http:") fail("An update comes over http(s)");
  return { ...offer as Offer, url: url.href };
}

/** What a binary says its version is (`--version`), or why it didn't. */
const versionOf = (path: string) =>
  new Promise<string>((resolve, reject) => {
    execFile(path, ["--version"], { timeout: 15_000, windowsHide: true }, (error, out) => {
      if (error) reject(new Error(`The new version didn't run: ${error.message}`));
      else resolve(out.trim());
    });
  });

/** Fetches `offer` into `path`, checking its size and SHA-256 as it comes. */
async function fetchChecked(offer: Offer, path: string, signal?: AbortSignal) {
  const response = await fetch(offer.url, { signal });
  if (!response.ok || !response.body) {
    fail(`Couldn't download ${offer.url}: ${response.status} ${response.statusText}`);
  }
  const hash = createHash("sha256");
  const file = await open(path, "wx", 0o700);
  let size = 0;
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > offer.size) fail(`${offer.url} is larger than the app said`);
      hash.update(chunk);
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }
  if (size !== offer.size) fail(`${offer.url} is ${size} bytes, not ${offer.size}`);
  const sha256 = hash.digest("hex");
  if (sha256 !== offer.sha256.toLowerCase()) {
    fail(`${offer.url}'s SHA-256 is ${sha256}, not ${offer.sha256}: not updated`);
  }
}

/** A new file beside `program`, for what replaces it. */
const besideOf = (program: string) =>
  join(dirname(program), `.${basename(program)}.${randomBytes(4).toString("hex")}`);

/**
 * Puts `next` (beside it) in `program`'s place: a rename, atomic; on Windows,
 * after renaming a running `program` aside.
 */
async function replace(next: string, program: string) {
  if (!WINDOWS) return await rename(next, program);
  const aside = `${program}.old-${randomBytes(4).toString("hex")}`;
  const there = await rename(program, aside).then(() => true, (error) => {
    if (error?.code !== "ENOENT") throw error;
    return false;
  });
  await rename(next, program).catch(async (error) => {
    if (there) await rename(aside, program);
    throw error;
  });
}

/**
 * The update this process is making now, if any: apps (orgs) it serves may
 * offer one at once, and it's made once. Done (or failed), another can be.
 */
let making: Promise<void> | undefined;

/**
 * Replaces `program` (this program, running) with `offer`'s binary, once it
 * checks (see above). It fails, leaving `program` as it was, if it doesn't.
 */
export function updateProgram(program: string, offer: Offer, signal?: AbortSignal): Promise<void> {
  return making ??= updateOnce(program, offer, signal).finally(() => making = undefined);
}

async function updateOnce(program: string, offer: Offer, signal?: AbortSignal) {
  const next = besideOf(program);
  try {
    await fetchChecked(offer, next, signal);
    await chmod(next, 0o755);
    const said = await versionOf(next);
    if (said !== offer.version) fail(`The new binary says it's ${said}, not ${offer.version}`);
    await replace(next, program);
  } catch (error) {
    await rm(next, { force: true }).catch(() => {});
    throw error;
  }
}

/** Copies `program` (this one, run from wherever it was downloaded) to `to`, where it's kept. */
export async function copyProgram(program: string, to: string) {
  await mkdir(dirname(to), { recursive: true });
  const next = besideOf(to);
  try {
    await copyFile(program, next);
    await chmod(next, 0o755);
    await replace(next, to);
  } catch (error) {
    await rm(next, { force: true }).catch(() => {});
    throw error;
  }
}

/** Removes what updates on Windows left aside, those it can (one still running stays). */
export async function tidyAside(program: string) {
  const prefix = `${basename(program)}.old-`;
  const names = await readdir(dirname(program)).catch(() => [] as string[]);
  await Promise.all(
    names.filter((name) => name.startsWith(prefix))
      .map((name) => rm(join(dirname(program), name), { force: true }).catch(() => {})),
  );
}
