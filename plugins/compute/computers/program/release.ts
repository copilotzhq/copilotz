/**
 * A release of the computer program, as `scripts/computer/build.ts` makes it
 * and an app serves it (the computers plugin's `downloads`): `install.sh` and
 * `install.ps1`, a binary per platform, and `manifest.json`, which says the
 * version and each binary's file, size and SHA-256. Plain data and functions
 * only: the build, the app, its web front end and the program all read it.
 */

/**
 * The work an app offers a computer a newer release with (`computer.update`;
 * the computers plugin's `computer` workers serve it beside `WORK`'s): the
 * version, and the computer's platform's binary, which it fetches, checks
 * (its size and SHA-256, said here, over the app's own connection) and runs.
 * It answers `{ updating }`: whether it's updating to it (not when it's that
 * version or newer, or updating already). Only the built program takes it.
 */
export const UPDATE = "computer.update";
export type Offer = { version: string; url: string; size: number; sha256: string };

/** Where an app serves a release of its own, on its origin (the install scripts' default). */
export const DOWNLOADS = "/computer/download/";

/** A platform, as Node names it (`process.platform`, `process.arch`). */
export type Platform = { os: string; arch: string };

/** One platform's binary in a release. */
export type Binary = Platform & { file: string; size: number; sha256: string };

/** What `manifest.json` says. */
export type Manifest = { version: string; binaries: Binary[] };

/**
 * The platforms it's built for, with Bun's target for each. The x64 ones are
 * Bun's baseline builds: they run on any x86-64 CPU of the last fifteen years
 * (no AVX2, which virtual machines often hide), at a speed that doesn't
 * matter for a program that mostly waits on shells and sockets.
 */
export const PLATFORMS = [
  { os: "darwin", arch: "arm64", target: "bun-darwin-arm64" },
  { os: "darwin", arch: "x64", target: "bun-darwin-x64-baseline" },
  { os: "linux", arch: "x64", target: "bun-linux-x64-baseline" },
  { os: "linux", arch: "arm64", target: "bun-linux-arm64" },
  { os: "win32", arch: "x64", target: "bun-windows-x64-baseline" },
] as const;

/** What people call an OS. */
export const OS_NAMES: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/** A platform's binary, by name: `copilotz-computer-macos-arm64`, `…-windows-x64.exe`. */
export const binaryName = ({ os, arch }: Platform): string =>
  `copilotz-computer-${os === "darwin" ? "macos" : os === "win32" ? "windows" : os}-${arch}${
    os === "win32" ? ".exe" : ""
  }`;

/** The release's binary for a platform, if it has one. */
export const binaryFor = (manifest: Manifest, { os, arch }: Platform): Binary | undefined =>
  manifest.binaries.find((binary) => binary.os === os && binary.arch === arch);

/**
 * The one line that installs the program and connects it with `code`: on
 * macOS and Linux (`sh`), or in Windows' PowerShell. `base` is where the
 * release is (absolute), named only when it isn't the app's own.
 */
export function installCommand(
  shell: "sh" | "powershell",
  { app, code, base }: { app: string; code: string; base: string },
): string {
  const own = base === new URL(DOWNLOADS, app).href;
  return shell === "sh"
    ? `curl -fsSL ${base}install.sh | sh -s -- ${app} --code ${code}${own ? "" : ` --from ${base}`}`
    : `& ([scriptblock]::Create((irm ${base}install.ps1))) ${app} -Code ${code}${
      own ? "" : ` -From ${base}`
    }`;
}

/** A version's parts: its numbers, and its pre-release's (`1.0.0-rc.1`: rc, 1). */
const parts = (version: string) => {
  const [core, pre = ""] = version.replace(/\+.*$/, "").split(/-(.*)/s);
  return { numbers: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
};

/** Whether version `a` is newer than `b`, as semver orders them (`1.0.0-rc.2` < `1.0.0`). */
export function newer(a: string, b: string): boolean {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const [m, n] = [x.numbers[i] || 0, y.numbers[i] || 0];
    if (m !== n) return m > n;
  }
  // A release is newer than its pre-releases.
  if (!x.pre.length || !y.pre.length) return !x.pre.length && !!y.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    if (p === undefined || q === undefined) return q === undefined;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) > Number(q);
    // Numbers come before words.
    if (pn !== qn) return qn;
    return p > q;
  }
  return false;
}
