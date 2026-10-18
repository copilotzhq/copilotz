/** Fixed protected-source check for aggregate reads, evaluated on owner SQL.
 * This is not a general query compiler or full JS depth/node validation. */
import {
  OWNER_PROTECTED_FAMILIES,
  OWNER_RESERVED_VALUE_KEYS,
} from "./ordinary-value.ts";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'::jsonpath`;
const objects = 'strict $.** ? (@.type() == "object").keyvalue()';
const keys = `${objects} ? (${
  OWNER_RESERVED_VALUE_KEYS.map((key) => `@.key == ${JSON.stringify(key)}`)
    .join(" || ")
})`;
const families = `^(${
  OWNER_PROTECTED_FAMILIES.map((name) => name.replaceAll(".", "[.]")).join("|")
})($|[.])`;
const schemas =
  `${objects} ? (@.key == "schema").value.** ? (@.type() == "string" && @ like_regex ${
    JSON.stringify(families)
  })`;

/** Fixed column from the existing aggregate evaluator; never caller SQL. */
export const OWNER_ORDINARY_SOURCE_SQL = `NOT jsonb_path_exists(data, ${
  literal(keys)
}) AND NOT jsonb_path_exists(data, ${literal(schemas)})`;
