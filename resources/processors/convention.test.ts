import {
  assert,
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

const processorsUrl = new URL("./", import.meta.url);
const durableEventFilePattern = /^[a-z0-9_]+\.[a-z0-9_]+$/;

Deno.test("built-in processor event files match exported durable eventTypes", async () => {
  const checkedFiles: string[] = [];

  for await (const purposeDir of Deno.readDir(processorsUrl)) {
    if (!purposeDir.isDirectory) continue;
    const purposeUrl = new URL(`${purposeDir.name}/`, processorsUrl);
    for await (const file of Deno.readDir(purposeUrl)) {
      if (
        !file.isFile ||
        !file.name.endsWith(".ts") ||
        file.name.endsWith(".test.ts") ||
        file.name.startsWith("_")
      ) {
        continue;
      }

      assert(
        file.name !== "index.ts",
        "processor event files must not be index.ts",
      );

      const basename = file.name.replace(/\.ts$/, "");
      const mod = await import(new URL(file.name, purposeUrl).href) as {
        eventTypes?: unknown;
        shouldProcess?: unknown;
        process?: unknown;
        default?: unknown;
      };
      const isProcessorEntry = typeof mod.shouldProcess === "function" &&
        (typeof mod.process === "function" ||
          typeof mod.default === "function");
      if (!isProcessorEntry) continue;

      assertMatch(basename, durableEventFilePattern);
      assert(
        Array.isArray(mod.eventTypes),
        `${purposeDir.name}/${file.name} must export eventTypes`,
      );

      const durableEventTypes = mod.eventTypes.filter((
        eventType,
      ): eventType is string =>
        typeof eventType === "string" &&
        eventType.includes(".") &&
        eventType === eventType.toLowerCase()
      );

      assertEquals(
        durableEventTypes,
        [basename],
        `${purposeDir.name}/${file.name}`,
      );
      checkedFiles.push(`${purposeDir.name}/${file.name}`);
    }
  }

  assert(checkedFiles.length > 0, "expected at least one processor event file");
});
