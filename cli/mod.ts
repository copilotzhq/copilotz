#!/usr/bin/env node
/** Builds plugin entry points for an app. Run `copilotz gen` in the directory containing app.ts. */
import { watchApp } from "./watch.ts";
import { regenerate } from "./run.ts";
import { resolve } from "node:path";
import process from "node:process";
import { init } from "./init.ts";
import { eject, generate } from "./generate.ts";

async function main(args: string[]) {
  const root = process.cwd();
  const [command = "gen", option, name, ...rest] = args[0]?.startsWith("--")
    ? ["gen", ...args]
    : args;
  if (command === "init" && !name) {
    const dir = resolve(root, option ?? ".");
    init(dir);
    return regenerate(dir, import.meta.url);
  }
  if (command === "gen" && option === "--eject" && !rest.length) {
    await eject(root, name);
    return regenerate(root, import.meta.url);
  }
  if (command === "gen" && !name) {
    if (!option || option === "--check") return await generate(root, option === "--check");
    if (option === "--watch") return watchApp(root, import.meta.url);
  }
  throw new Error(
    "Usage: copilotz gen [--check | --watch | --eject [plugin]] | copilotz init [dir]",
  );
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
