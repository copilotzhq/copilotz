/**
 * Every Action the app has, as the API's reference says them (`GET /api/`
 * from the app's own page, signed in): each one's description and input,
 * for choosing what a key does and for a key's reference. Asked once per
 * page, when first shown.
 */
import { useEffect, useState } from "react";

export type ActionEntry = { name: string; description?: string; input?: Schema };

/** As much of a JSON Schema as the reference shows. */
export type Schema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
};

/** The catalog: loading, there, or not to be had here (an older host, signed out). */
export type Catalog = ActionEntry[] | "loading" | "unavailable";

let asked: Promise<ActionEntry[] | null> | undefined;

const ask = () =>
  asked ??= fetch("/api/", { headers: { accept: "application/json" } })
    .then(async (response) =>
      response.ok ? ((await response.json()) as { actions?: ActionEntry[] }).actions ?? null : null
    )
    .catch(() => null);

export function useCatalog(on = true): Catalog {
  const [catalog, setCatalog] = useState<Catalog>("loading");
  useEffect(() => {
    if (!on) return;
    let live = true;
    void ask().then((found) => {
      if (live) setCatalog(found ?? "unavailable");
    });
    return () => {
      live = false;
    };
  }, [on]);
  return catalog;
}

/** An input's fields, as a reference lists them: name, type, required, what it is. */
export function fieldsOf(input: Schema | undefined) {
  const required = new Set(input?.required ?? []);
  return Object.entries(input?.properties ?? {}).map(([name, schema]) => ({
    name,
    type: typeOf(schema),
    required: required.has(name),
    ...(schema.description ? { description: schema.description } : {}),
  }));
}

const typeOf = (schema: Schema): string => {
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  const type = [schema.type ?? "any"].flat().join(" | ");
  return type === "array" && schema.items ? `${typeOf(schema.items)}[]` : type;
};
