import type { SkillResourceReader } from "../../tools/index.ts";

function safeReferencePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new TypeError("Skill resource path must remain inside references/.");
  }
  return normalized.split("/").filter((part) => part && part !== ".").join(
    "/",
  );
}

/** Deno filesystem reader injected into createBuiltInToolsPlugin(). */
export function createDenoSkillResourceReader(): SkillResourceReader {
  return async ({ skill, path, signal }) => {
    if (signal.aborted) {
      throw signal.reason ?? new DOMException("Cancelled", "AbortError");
    }
    if (skill.source === "remote") {
      throw new Error("Remote skills cannot expose filesystem references.");
    }
    if (!skill.hasReferences) {
      throw new Error(`Skill '${skill.name}' has no references directory.`);
    }
    const resource = safeReferencePath(path);
    if (!resource) throw new TypeError("Skill resource path is required.");
    return await Deno.readFile(`${skill.sourcePath}/references/${resource}`);
  };
}
