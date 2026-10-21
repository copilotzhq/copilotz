import { compileCollectionFilters } from "../collections/query.ts";
import {
  type CollectionPredicate,
  compareCodePoints,
} from "../collections/predicate.ts";
import { stableStringify } from "../collections/equal.ts";
import type {
  CollectionFilter,
  CollectionRecord,
} from "../collections/types.ts";

export const queryRefused = (message: string, reason = "query_unsupported") =>
  Object.assign(new TypeError(message), {
    code: "subscription_query_refused",
    reason,
  });
export type LivePredicateLimits = {
  maxPredicateNodes: number;
  maxPredicateValues: number;
  maxQueryBytes: number;
};
type Match = (row: CollectionRecord) => boolean;

/** Compiles both policy and query once. No constant serialization runs on commit. */
export function compileLiveFilters(
  filters: readonly CollectionFilter[],
  limits: LivePredicateLimits,
  schema: unknown,
): Match {
  const scalarField = (field: string) => {
    if (field === "id") return true;
    let node = schema as {
      properties?: Record<string, unknown>;
      type?: unknown;
    } | undefined;
    for (const part of field.split(".")) {
      node = node?.properties?.[part] as typeof node;
    }
    const types = Array.isArray(node?.type) ? node.type : [node?.type];
    return types.length > 0 &&
      types.every((type) =>
        ["string", "number", "integer", "boolean", "null"].includes(
          String(type),
        )
      );
  };
  const numericText = (value: number) => {
    const text = String(value);
    if (!text.includes("e")) return text;
    const [mantissa, exponent] = text.split("e");
    const sign = mantissa.startsWith("-") ? "-" : "";
    const digits = mantissa.replace("-", "").replace(".", "");
    const point = (mantissa.replace("-", "").split(".")[0].length) +
      Number(exponent);
    return sign +
      (point <= 0
        ? "0." + "0".repeat(-point) + digits
        : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : digits.slice(0, point) + "." + digits.slice(point));
  };
  let nodes = 0;
  const count = () => {
    if (++nodes > limits.maxPredicateNodes) {
      throw queryRefused(
        "Subscription predicate node limit exceeded",
        "limit_exceeded",
      );
    }
  };
  const at = (field: string) => {
    const path = field.split(".");
    return (row: CollectionRecord): unknown =>
      path.reduce<unknown>(
        (value, key) =>
          value !== null && typeof value === "object" &&
            !Array.isArray(value) && Object.hasOwn(value, key)
            ? (value as Record<string, unknown>)[key]
            : undefined,
        row,
      );
  };
  const predicate = (p: CollectionPredicate): Match => {
    count();
    if ("and" in p) {
      const children = p.and.map(predicate);
      return (row) => children.every((f) => f(row));
    }
    if ("or" in p) {
      const children = p.or.map(predicate);
      return (row) => children.some((f) => f(row));
    }
    if ("not" in p) {
      const child = predicate(p.not);
      return (row) => !child(row);
    }
    if ("jsonEquals" in p || "eqIgnoreCase" in p || "inIgnoreCase" in p) {
      throw queryRefused(
        "Live predicates refuse jsonEquals and locale-dependent case folding",
      );
    }
    // PostgreSQL accepts a much broader timestamp grammar than Date.parse.
    // Do not approximate that grammar (or its microsecond rounding) in policies.
    if (
      ["createdAt", "updatedAt"].includes(p.field)
    ) {
      throw queryRefused("Live timestamp predicates are unsupported");
    }
    const get = at(p.field);
    if ("exists" in p) return (row) => p.exists === (get(row) !== undefined);
    if ("isNull" in p) return (row) => p.isNull === (get(row) === null);
    if ("isBlank" in p) {
      return (row) => {
        const v = get(row);
        return p.isBlank === (typeof v === "string" && v.trim() === "");
      };
    }
    if ("trimEq" in p) {
      return (row) => {
        const v = get(row);
        return typeof v === "string" && v.trim() === p.trimEq;
      };
    }
    if ("in" in p || "overlaps" in p) {
      const values = "in" in p ? p.in : p.overlaps;
      if (values.length > limits.maxPredicateValues) {
        throw queryRefused(
          "Subscription predicate value limit exceeded",
          "limit_exceeded",
        );
      }
      const constants = new Set(values.map(stableStringify));
      return "in" in p
        ? (row) => constants.has(stableStringify(get(row)))
        : (row) => {
          const v = get(row);
          return Array.isArray(v) &&
            v.some((x) => constants.has(stableStringify(x)));
        };
    }
    if ("eq" in p || "ne" in p) {
      const constant = stableStringify("eq" in p ? p.eq : p.ne);
      return "eq" in p
        ? (row) => stableStringify(get(row)) === constant
        : (row) => stableStringify(get(row)) !== constant;
    }
    const op = "lt" in p ? "lt" : "lte" in p ? "lte" : "gt" in p ? "gt" : "gte";
    const expected = (p as unknown as Record<string, string | number>)[op];
    return (row) => {
      const actual = get(row);
      if (typeof actual !== typeof expected) return false;
      const comparison = typeof actual === "string"
        ? compareCodePoints(actual, expected as string)
        : (actual as number) < (expected as number)
        ? -1
        : actual === expected
        ? 0
        : 1;
      return op === "lt"
        ? comparison < 0
        : op === "lte"
        ? comparison <= 0
        : op === "gt"
        ? comparison > 0
        : comparison >= 0;
    };
  };
  try {
    if (
      new TextEncoder().encode(JSON.stringify(filters)).length >
        limits.maxQueryBytes
    ) {
      throw queryRefused(
        "Subscription filter bytes exceeded",
        "limit_exceeded",
      );
    }
    // PostgreSQL text/jsonb cannot represent NUL or unpaired UTF-16 surrogates.
    const unicode = (value: unknown): void => {
      if (
        typeof value === "string" &&
        (value.includes("\0") || !value.isWellFormed())
      ) {
        throw queryRefused(
          "Live filters require PostgreSQL-compatible Unicode strings",
        );
      }
      if (Array.isArray(value)) value.forEach(unicode);
      else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          unicode(key);
          unicode(child);
        }
      }
    };
    unicode(filters);
    compileCollectionFilters(filters, []);
    const compiled = filters.flatMap((filter) => {
      if (
        Object.keys(filter.contains ?? {}).length ||
        Object.keys(filter.containsAny ?? {}).length
      ) {
        throw queryRefused(
          "Live JSON containment is unsupported; use bounded scalar predicates",
        );
      }
      const matches: Match[] = filter.filter ? [predicate(filter.filter)] : [];
      for (const [field, value] of Object.entries(filter.where ?? {})) {
        count();
        if (
          !scalarField(field) ||
          ["namespace", "createdAt", "updatedAt"].includes(field) ||
          typeof value === "number" && !Number.isFinite(value) ||
          value !== null &&
            !["string", "number", "boolean"].includes(typeof value)
        ) {
          throw queryRefused("Live where requires data scalar fields");
        }
        const get = at(field),
          expected = value === null ? undefined : String(value);
        matches.push((row) => {
          const actual = get(row);
          return expected !== undefined &&
            ["string", "number", "boolean"].includes(typeof actual) &&
            (typeof actual === "number"
                ? numericText(actual)
                : String(actual)) === expected;
        });
      }
      return matches;
    });
    return (row) => compiled.every((match) => match(row));
  } catch (error) {
    if ((error as { code?: string }).code === "subscription_query_refused") {
      throw error;
    }
    throw queryRefused(
      error instanceof Error ? error.message : "Invalid live filter",
    );
  }
}
