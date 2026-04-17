const REDACTED_VALUE = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "apikey",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearertoken",
  "secret",
  "clientsecret",
  "password",
  "cookie",
  "setcookie",
  "xapikey",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function shouldRedactKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value instanceof Date) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(record)) {
    out[key] = shouldRedactKey(key) ? REDACTED_VALUE : redactValue(child);
  }

  return out;
}

export function redactEventForStream<T>(event: T): T {
  if (
    event &&
    typeof event === "object" &&
    "type" in (event as Record<string, unknown>) &&
    (event as Record<string, unknown>).type === "TOKEN"
  ) {
    return event;
  }

  return redactValue(event) as T;
}
