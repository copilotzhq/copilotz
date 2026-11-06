/**
 * Categories: what people read a use as, by its meter. Agents' are the
 * models' meters (`llm`, `embeddings`, `transcription`, `image`), computers' the
 * cloud's (`computer`), apps' theirs (`app`). A meter in none is a category
 * of its own, by its name (an app's `tool`).
 *
 * Totals group by `category` and filter by it (`{ category: "agents" }`) as
 * by any field: it reads as the meters it holds, so rollups serve it as they
 * serve `meter`.
 */
import type { Filter } from "../../../../runtime/mod.ts";

/** Each category's meters: the `usage` resource's `categories`, these by default. */
export type Categories = Record<string, string[]>;

export const CATEGORIES: Categories = {
  agents: ["llm", "embeddings", "transcription", "image"],
  computers: ["computer"],
  apps: ["app"],
};

/** A meter's category: the one that holds it, else its own name. */
export const categoryOf = (meter: unknown, categories: Categories): string | null => {
  if (typeof meter !== "string") return null;
  for (const [name, meters] of Object.entries(categories)) if (meters.includes(meter)) return name;
  return meter;
};

/** A category's meters: those it holds, else (a meter of its own) itself. */
export const metersOf = (category: string, categories: Categories): string[] =>
  categories[category] ?? [category];

const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid" });

/**
 * A filter with `category` said as the meters it holds: a name, or names
 * (`{ $in: [...] }`). With a meter named too, what both allow.
 */
export function byMeters(filter: Filter, categories: Categories): Filter {
  if (!("category" in filter)) return filter;
  const { category, ...rest } = filter as Filter & { category: unknown };
  const names = typeof category === "string"
    ? [category]
    : category && typeof category === "object" && Array.isArray((category as { $in?: unknown }).$in)
    ? (category as { $in: unknown[] }).$in
    : undefined;
  if (!names?.every((name) => typeof name === "string")) {
    throw invalid("A category filter is a name, or { $in: [names] }");
  }
  const meters = [...new Set((names as string[]).flatMap((name) => metersOf(name, categories)))];
  if (rest.meter === undefined) return { ...rest, meter: { $in: meters } };
  if (typeof rest.meter !== "string") throw invalid("Filter by category or by meter, not both");
  return { ...rest, meter: meters.includes(rest.meter) ? rest.meter : { $in: [] } };
}
