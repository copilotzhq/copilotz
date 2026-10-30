/**
 * The API's reference, made from what the plugins declare
 * (`runtime.describe()`): for a key, what it may call, each Action with its
 * description and its input's JSON Schema, its queries and Views by name,
 * and where to call each; for a person choosing what a key does, every
 * Action the app has (the catalog).
 */
import type { Description } from "../../../../runtime/mod.ts";

export type Allowed = { actions: string[]; queries: string[]; views?: string[] };

export type ActionEntry = {
  name: string;
  description?: string;
  input?: unknown;
  method: "POST";
  path: string;
};

export type Reference = {
  key?: { name: string; in: string; hint: string };
  actions: ActionEntry[];
  queries: { name: string; method: "POST"; path: string }[];
  views: { name: string; method: "GET"; path: string }[];
  events: { method: "GET"; path: string };
};

const enc = encodeURIComponent;

/** What a key may call, as the app declares it; names the app doesn't have are left out. */
export function referenceOf(described: Description, allowed: Allowed): Reference {
  return {
    actions: allowed.actions.flatMap((name) => {
      const action = described.actions[name];
      return action ? [actionEntry(name, action)] : [];
    }),
    queries: allowed.queries.map((name) => ({
      name,
      method: "POST",
      path: `/api/queries/${enc(name)}`,
    })),
    views: (allowed.views ?? []).map((name) => ({
      name,
      method: "GET",
      path: `/api/views/${enc(name)}`,
    })),
    events: { method: "GET", path: "/api/events" },
  };
}

/** Every Action the app has, by name, for choosing what a key does. */
export const catalogOf = (described: Description): ActionEntry[] =>
  Object.entries(described.actions)
    .map(([name, action]) => actionEntry(name, action))
    .sort((a, b) => a.name.localeCompare(b.name));

const actionEntry = (
  name: string,
  action: { description?: string; input?: unknown },
): ActionEntry => ({
  name,
  ...(action.description ? { description: action.description } : {}),
  ...(action.input ? { input: action.input } : {}),
  method: "POST",
  path: `/api/actions/${enc(name)}`,
});

/** Whether an Action takes a space (`in`) in its input: a key's, when the body names none. */
export const takesSpace = (described: Description, action: string): boolean => {
  const input = described.actions[action]?.input as
    | { properties?: Record<string, unknown> }
    | undefined;
  return !!input?.properties && "in" in input.properties;
};
