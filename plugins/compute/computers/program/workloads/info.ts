/** What the machine is: `computer.info`. */
import { hostname } from "node:os";
import process from "node:process";
import type { Info } from "../../shared/workloads.ts";
import { VERSION } from "../version.ts";
import type { Shell } from "./shell.ts";

/**
 * This machine, with the root its spaces are in, the shell its commands run
 * in (its path: bash, or PowerShell's on Windows), the browser it drives, its
 * name and windows.
 */
export function machineInfo(
  root: string,
  shell: Shell,
  browser: string | null,
  name?: string,
  windows: "allow" | "never" = "allow",
): Info {
  return {
    os: process.platform,
    arch: process.arch,
    hostname: hostname(),
    root,
    shell: shell.path,
    browser,
    version: VERSION,
    ...(name ? { name } : {}),
    windows,
  };
}
