/**
 * MongoDB updates as PostgreSQL expressions over the stored `jsonb`, so an
 * update is one statement instead of a read and a write.
 */
import type { Update } from "../../../runtime/store.ts";
import type { Bind } from "../shared/filter.ts";

/**
 * The SQL for an update, when it only touches top-level fields with `$set`,
 * `$unset`, `$inc`, `$push`, `$addToSet` and `$pull` (applied in that order,
 * like the reference; `$addToSet` and `$pull` with a plain value), or is a
 * replacement document. Anything else returns undefined.
 */
export function expression(
  update: Update | Record<string, unknown>,
): ((bind: Bind) => string) | undefined {
  const ops = Object.keys(update);
  if (!ops.some((op) => op.startsWith("$"))) {
    return (bind) => `jsonb_set(${bind(JSON.stringify(update))}::jsonb, '{_id}', to_jsonb(t.id))`;
  }
  const u = update as Update;
  const fields = (op: string) => Object.keys(u[op] ?? {});
  const supported = ["$set", "$unset", "$inc", "$push", "$addToSet", "$pull"];
  if (ops.some((op) => !supported.includes(op))) return undefined;
  const all = supported.flatMap(fields);
  if (all.some((field) => field.includes(".") || field.startsWith("$") || field === "_id")) {
    return undefined;
  }
  if (Object.values(u.$inc ?? {}).some((by) => typeof by !== "number")) return undefined;
  const plain = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
  if (
    [...Object.values(u.$addToSet ?? {}), ...Object.values(u.$pull ?? {})].some((v) => !plain(v))
  ) {
    return undefined;
  }
  return (bind) => {
    let sql = "t.doc";
    if (fields("$set").length) sql = `(${sql} || ${bind(JSON.stringify(u.$set))}::jsonb)`;
    if (fields("$unset").length) sql = `(${sql} - ${bind(fields("$unset"))}::text[])`;
    for (const [field, by] of Object.entries(u.$inc ?? {})) {
      // Like Number(x) || 0 in the reference: a missing or non-number field counts as 0.
      const current = `CASE WHEN jsonb_typeof(${sql} -> ${bind(field)}) = 'number' THEN ` +
        `(${sql} ->> ${bind(field)})::float8 ELSE 0 END`;
      sql = `jsonb_set(${sql}, ARRAY[${bind(field)}], to_jsonb(${current} + ${bind(by)}::float8))`;
    }
    // Like the reference, a field that isn't an array counts as an empty one.
    const list = (field: string) =>
      `(CASE WHEN jsonb_typeof(${sql} -> ${bind(field)}) = 'array' THEN ${sql} -> ${
        bind(field)
      } ELSE '[]'::jsonb END)`;
    const put = (field: string, value: string) =>
      `jsonb_set(${sql}, ARRAY[${bind(field)}], ${value})`;
    for (const [field, value] of Object.entries(u.$push ?? {})) {
      const items = value && typeof value === "object" && "$each" in value
        ? (value as { $each: unknown[] }).$each
        : [value];
      sql = put(field, `${list(field)} || ${bind(JSON.stringify(items))}::jsonb`);
    }
    for (const [field, value] of Object.entries(u.$addToSet ?? {})) {
      const v = `${bind(JSON.stringify(value))}::jsonb`;
      const current = list(field);
      sql = put(
        field,
        `CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(${current}) e(e) WHERE e = ${v}) ` +
          `THEN ${current} ELSE ${current} || jsonb_build_array(${v}) END`,
      );
    }
    for (const [field, value] of Object.entries(u.$pull ?? {})) {
      // Equality also matches an element of an array item, as in the reference.
      const v = `${bind(JSON.stringify(value))}::jsonb`;
      sql = put(
        field,
        `(SELECT coalesce(jsonb_agg(e ORDER BY i), '[]'::jsonb) FROM jsonb_array_elements(${
          list(field)
        }) WITH ORDINALITY x(e, i) WHERE NOT (e = ${v} OR (jsonb_typeof(e) = 'array' AND ` +
          `EXISTS (SELECT 1 FROM jsonb_array_elements(e) y(y) WHERE y = ${v}))))`,
      );
    }
    return sql;
  };
}
