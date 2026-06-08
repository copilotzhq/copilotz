const NULL_CHAR_PATTERN = /\u0000|\\u0000/gi;

function isBinaryLike(value: unknown): boolean {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function sanitizeValueForPostgres<T>(
  value: T,
  seen: WeakMap<object, unknown>,
): T {
  if (typeof value === "string") {
    return value.replace(NULL_CHAR_PATTERN, "") as T;
  }

  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date || isBinaryLike(value)) return value;

  const cached = seen.get(value);
  if (cached !== undefined) return "[Circular]" as T;

  if (Array.isArray(value)) {
    const next: unknown[] = [];
    seen.set(value, next);
    for (const item of value) {
      next.push(sanitizeValueForPostgres(item, seen));
    }
    return next as T;
  }

  const next: Record<string, unknown> = {};
  seen.set(value, next);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    next[key.replace(NULL_CHAR_PATTERN, "")] = sanitizeValueForPostgres(
      child,
      seen,
    );
  }
  return next as T;
}

export function sanitizePostgresParam<T>(value: T): T {
  return sanitizeValueForPostgres(value, new WeakMap<object, unknown>());
}

export function sanitizePostgresParams(
  params?: unknown[],
): unknown[] | undefined {
  if (!params) return undefined;
  return params.map((param) => sanitizePostgresParam(param));
}
