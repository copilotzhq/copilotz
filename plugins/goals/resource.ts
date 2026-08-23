import type {
  GoalJsonValue,
  GoalResource,
  GoalResourceSnapshot,
} from "./types.ts";

const RESOURCE_KEYS = new Set([
  "target",
  "lead",
  "judge",
  "maxTurns",
  "stopAction",
  "evaluateAction",
  "stopPolicy",
  "evaluatePolicy",
]);
const JUDGE_KEYS = new Set(["agent", "instructions"]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function knownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new TypeError(`${label} cannot declare '${unknown}'.`);
}

function canonicalProperties(
  value: Readonly<Record<string, unknown>>,
  label: string,
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} cannot contain symbol properties.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(
        `${label}.${key} must be an enumerable data property.`,
      );
    }
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new TypeError(
      `${label} must be non-empty without surrounding whitespace.`,
    );
  }
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

function jsonValue(
  value: unknown,
  label: string,
  seen = new Set<object>(),
): GoalJsonValue {
  if (
    value === null || typeof value === "string" ||
    typeof value === "boolean"
  ) return value;
  if (
    typeof value === "number" && Number.isFinite(value) &&
    !Object.is(value, -0)
  ) return value;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(`${label} must be a plain JSON array.`);
    }
    if (seen.has(value)) throw new TypeError(`${label} cannot contain cycles.`);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) =>
        key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) ||
          Number(key) >= value.length)
      ) ||
      Object.keys(value).length !== value.length
    ) {
      throw new TypeError(
        `${label} must be a dense JSON array without extra properties.`,
      );
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(
          `${label}[${index}] must be an enumerable data property.`,
        );
      }
    }
    seen.add(value);
    const entries: GoalJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))!;
      entries.push(jsonValue(descriptor.value, `${label}[${index}]`, seen));
    }
    const result = Object.freeze(entries);
    seen.delete(value);
    return result;
  }
  if (plainRecord(value)) {
    if (seen.has(value)) throw new TypeError(`${label} cannot contain cycles.`);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError(`${label} cannot contain symbol properties.`);
      }
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new TypeError(`${label} cannot contain unsafe key '${key}'.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(
          `${label}.${key} must be an enumerable data property.`,
        );
      }
    }
    seen.add(value);
    const result = Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (entry === undefined) {
          throw new TypeError(`${label}.${key} cannot be undefined.`);
        }
        return [key, jsonValue(entry, `${label}.${key}`, seen)];
      }),
    ));
    seen.delete(value);
    return result;
  }
  throw new TypeError(`${label} must be JSON-safe data.`);
}

function normalizeGoal(resource: GoalResource): GoalResource {
  if (!plainRecord(resource)) {
    throw new TypeError("Goal Resource must be a plain object.");
  }
  canonicalProperties(resource, "Goal Resource");
  knownKeys(resource, RESOURCE_KEYS, "Goal Resource");
  const maxTurns = resource.maxTurns;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 1_000) {
    throw new TypeError(
      "Goal Resource maxTurns must be an integer from 1 through 1000.",
    );
  }
  let judge: GoalResource["judge"];
  if (resource.judge !== undefined) {
    if (!plainRecord(resource.judge)) {
      throw new TypeError("Goal Resource judge must be an object.");
    }
    canonicalProperties(resource.judge, "Goal Resource judge");
    knownKeys(resource.judge, JUDGE_KEYS, "Goal Resource judge");
    judge = Object.freeze({
      agent: text(resource.judge.agent, "Goal Resource judge agent"),
      ...(resource.judge.instructions === undefined ? {} : {
        instructions: text(
          resource.judge.instructions,
          "Goal Resource judge instructions",
        ),
      }),
    });
    if (resource.evaluateAction === undefined) {
      throw new TypeError(
        "Goal Resource requires evaluateAction when judge is configured.",
      );
    }
  }
  return Object.freeze({
    target: text(resource.target, "Goal Resource target alias"),
    lead: text(resource.lead, "Goal Resource lead alias"),
    ...(judge ? { judge } : {}),
    maxTurns,
    ...(resource.stopAction === undefined ? {} : {
      stopAction: optionalText(
        resource.stopAction,
        "Goal Resource stop Action alias",
      ),
    }),
    ...(resource.evaluateAction === undefined ? {} : {
      evaluateAction: optionalText(
        resource.evaluateAction,
        "Goal Resource evaluate Action alias",
      ),
    }),
    ...(resource.stopPolicy === undefined ? {} : {
      stopPolicy: jsonValue(resource.stopPolicy, "Goal Resource stop policy"),
    }),
    ...(resource.evaluatePolicy === undefined ? {} : {
      evaluatePolicy: jsonValue(
        resource.evaluatePolicy,
        "Goal Resource evaluate policy",
      ),
    }),
  });
}

/** Validates and deeply freezes one data-only Goal Resource. */
export function defineGoal<const TResource extends GoalResource>(
  resource: TResource,
): TResource {
  return normalizeGoal(resource) as TResource;
}

export function snapshotGoalResource(
  alias: string,
  resource: GoalResource,
): GoalResourceSnapshot {
  const normalizedAlias = text(alias, "Goal Resource alias");
  return Object.freeze({
    alias: normalizedAlias,
    ...normalizeGoal(resource),
  });
}

export function cloneGoalJson<T extends GoalJsonValue>(
  value: T,
  label = "Goal JSON value",
): T {
  return jsonValue(value, label) as T;
}
