#!/usr/bin/env node
/** The public /gen entry also serves as the npm bin. Importing it leaves the app alone. */
import { existsSync, realpathSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

// Node 24.0 and 24.1 have no import.meta.main. npm may launch through a symlink.
const entry = process.argv[1];
if (
  import.meta.main ??
    (entry && existsSync(entry) && pathToFileURL(realpathSync(entry)).href === import.meta.url)
) {
  await import("./bin.ts");
}
