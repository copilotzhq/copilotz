/**
 * A call's request, from its plan and input: path parameters encoded into
 * the path, query parameters by their `style` and `explode` (form, space- or
 * pipe-delimited, deepObject), header and cookie parameters as headers, and
 * a JSON body for the methods that carry one.
 */
import type { Param, Plan } from "./plan.ts";

export type Built = { url: string; method: string; headers: Headers; body?: string };

const enc = encodeURIComponent;

/** One value as a parameter's text: scalars as they are, anything deeper as JSON. */
const text = (value: unknown) =>
  typeof value === "string"
    ? value
    : value !== null && typeof value === "object"
    ? JSON.stringify(value)
    : String(value);

/** A value's parts: an array's items, or an object's keys and values in turn (or `k=v`). */
function parts(value: unknown, explode: boolean, encode = (s: string) => s): string[] {
  if (Array.isArray(value)) return value.map((v) => encode(text(v)));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) =>
      explode ? [`${encode(k)}=${encode(text(v))}`] : [encode(k), encode(text(v))]
    );
  }
  return [encode(text(value))];
}

/** A path, header or cookie value (simple style: `a,b`; exploded objects `k=v,k2=v2`). */
const simple = (p: Param, value: unknown, encode?: (s: string) => string) =>
  p.json ? (encode ?? String)(JSON.stringify(value)) : parts(value, p.explode, encode).join(",");

/** A query parameter's `name=value` pairs, encoded. */
function query(p: Param, value: unknown): string[] {
  const name = enc(p.name);
  if (p.json) return [`${name}=${enc(JSON.stringify(value))}`];
  const scalar = value === null || typeof value !== "object";
  if (scalar) return [`${name}=${enc(text(value))}`];
  if (p.style === "deepObject" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).map(([k, v]) =>
      `${name}[${enc(k)}]=${enc(text(v))}`
    );
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => enc(text(v)));
    if (p.style === "spaceDelimited") return [`${name}=${items.join("%20")}`];
    if (p.style === "pipeDelimited") return [`${name}=${items.join("%7C")}`];
    return p.explode ? items.map((v) => `${name}=${v}`) : [`${name}=${items.join(",")}`];
  }
  // An object, in form style: its properties as parameters of their own, or `name=k,v`.
  return p.explode
    ? Object.entries(value as Record<string, unknown>).map(([k, v]) => `${enc(k)}=${enc(text(v))}`)
    : [`${name}=${parts(value, false, enc).join(",")}`];
}

/** The request a call makes: `base` and the plan's path, the input where each part goes. */
export function build(
  plan: Plan,
  input: Record<string, unknown>,
  base: string,
  extra: Record<string, string> = {},
): Built {
  let path = plan.path;
  const search: string[] = [];
  const headers = new Headers({ accept: "application/json, */*;q=0.5" });
  const cookies: string[] = [];
  for (const p of plan.params) {
    const value = input[p.name];
    if (value === undefined || value === null) continue;
    if (p.in === "path") path = path.replaceAll(`{${p.name}}`, simple(p, value, enc));
    else if (p.in === "query") search.push(...query(p, value));
    else if (p.in === "header") headers.set(p.name, simple(p, value));
    else cookies.push(`${p.name}=${simple(p, value, enc)}`);
  }
  for (const [name, value] of Object.entries(extra)) search.push(`${enc(name)}=${enc(value)}`);
  if (cookies.length) headers.set("cookie", cookies.join("; "));

  let body: string | undefined;
  if (plan.body) {
    let value: unknown;
    if (plan.body.keys) {
      // An object body: the inputs that are its properties, and those nothing else names.
      const named = new Set(plan.params.map((p) => p.name));
      const keys = new Set(plan.body.keys);
      const fields = Object.entries(input).filter(([k, v]) =>
        v !== undefined && (keys.has(k) || (plan.body!.extra && !named.has(k)))
      );
      if (fields.length || plan.body.required) value = Object.fromEntries(fields);
    } else value = input.body;
    if (value !== undefined) {
      body = JSON.stringify(value);
      headers.set("content-type", plan.body.type);
    }
  }
  const url = base.replace(/\/+$/, "") + path +
    (search.length ? `${path.includes("?") ? "&" : "?"}${search.join("&")}` : "");
  return { url, method: plan.method, headers, ...(body !== undefined ? { body } : {}) };
}
