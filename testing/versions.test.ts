/**
 * One version, everywhere: Copilotz's deno.json and package.json, the
 * computer program's, and every product package's deno.json (and the
 * Copilotz it imports) and package.json. The release candidates are
 * released together (`node scripts/version.ts <version>` says it in each);
 * the publish workflow checks the tag against the same.
 */
import { assertEquals } from "@std/assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./mod.ts";

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

test("every package says Copilotz's version, and imports Copilotz at it", () => {
  const version = (JSON.parse(read("deno.json")) as { version: string }).version;
  const said: Record<string, string | undefined> = {
    "package.json": JSON.parse(read("package.json")).version,
    "the computer program": /VERSION = "(.+)"/.exec(
      read("plugins/compute/computers/program/version.ts"),
    )?.[1],
  };
  const packages = existsSync(join(ROOT, "packages")) ? readdirSync(join(ROOT, "packages")) : [];
  for (const name of packages.filter((n) => existsSync(join(ROOT, "packages", n, "deno.json")))) {
    const deno = JSON.parse(read(`packages/${name}/deno.json`));
    said[`packages/${name}/deno.json`] = deno.version;
    said[`packages/${name}/package.json`] =
      JSON.parse(read(`packages/${name}/package.json`)).version;
    said[`packages/${name}'s copilotz`] = /^jsr:@copilotz\/copilotz@(.+)$/.exec(
      deno.imports?.copilotz ?? "",
    )?.[1];
  }
  assertEquals(
    Object.entries(said).filter(([, v]) => v !== version),
    [],
    `deno.json says ${version}`,
  );
});
