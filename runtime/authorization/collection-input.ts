import { captureHostCommandJson } from "../application/host-command-json.ts";
import { sameValue } from "../collections/equal.ts";

/** Policies inspect declared content references; bodies stay in the materializer. */
export function collectionAuthorizationInput(
  method: string,
  args: unknown,
  contentFields: readonly string[] = [],
) {
  const projected = structuredClone(args) as Record<string, unknown>;
  const prepared: { path: string[]; value: unknown; refs: unknown }[] = [];
  const at = (root: Record<string, unknown>, path: readonly string[]) => {
    let parent = root;
    for (const key of path.slice(0, -1)) {
      const child = parent[key];
      if (!child || typeof child !== "object" || Array.isArray(child)) return;
      parent = child as Record<string, unknown>;
    }
    return { parent, key: path.at(-1)! };
  };
  if (method === "create" || method === "update") {
    for (const field of contentFields) {
      const path = [method === "create" ? "input" : "set", ...field.split(".")];
      const selected = at(projected, path);
      if (!selected) continue;
      const value = selected.parent[selected.key] as
        | Record<string, unknown>
        | undefined;
      if (
        !value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some((key) =>
          key !== "content" && key !== "assets"
        ) ||
        !Array.isArray(value.content) || !Array.isArray(value.assets)
      ) continue;
      const refs = captureHostCommandJson(value.content);
      prepared.push({ path, value, refs });
      selected.parent[selected.key] = refs;
    }
  }
  const present = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(present);
    if (
      value && typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.entries(value).filter(([, child]) => child !== undefined).map((
          [key, child],
        ) => [key, present(child)]),
      );
    }
    return value;
  };
  const input = captureHostCommandJson(present(projected));
  return {
    input,
    materialize(authorized: unknown): Record<string, unknown> {
      const result = structuredClone(authorized) as Record<string, unknown>;
      for (const { path, value, refs } of prepared) {
        const selected = at(result, path);
        if (selected && sameValue(selected.parent[selected.key], refs)) {
          selected.parent[selected.key] = structuredClone(value);
        }
      }
      return result;
    },
  };
}
