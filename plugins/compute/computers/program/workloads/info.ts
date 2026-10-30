/** What the machine is: `computer.info`. */
import { access, constants } from "node:fs/promises";
import { hostname } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import type { Info } from "../../shared/workloads.ts";
import { VERSION } from "../version.ts";

/** The bash shells run: the first on the PATH, else /bin/bash. */
export async function findBash(): Promise<string> {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const path = join(dir, "bash");
    if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
  }
  return "/bin/bash";
}

/** This machine, with the root its spaces are in, the browser it drives, its name and windows. */
export async function machineInfo(
  root: string,
  browser: string | null,
  name?: string,
  windows: "allow" | "never" = "allow",
): Promise<Info> {
  return {
    os: process.platform,
    arch: process.arch,
    hostname: hostname(),
    root,
    shell: await findBash(),
    browser,
    version: VERSION,
    ...(name ? { name } : {}),
    windows,
  };
}
