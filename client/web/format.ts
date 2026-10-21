/**
 * Locale-aware display formatting shared by every View. Uses `Intl` with the
 * reader's locale unless one is given; nothing here hard-codes a language
 * beyond the overridable English group labels.
 * @module
 */

type Time = string | number | Date;

function time(value: Time): number {
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
    ? value
    : Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const DAY = 86_400_000;

/** A short absolute time: the clock today, the date this year, else with year. */
export function formatWhen(
  value: Time,
  options: { now?: Time; locale?: string } = {},
): string {
  const at = time(value);
  if (Number.isNaN(at)) return "";
  const now = time(options.now ?? Date.now());
  const date = new Date(at);
  if (startOfDay(at) === startOfDay(now)) {
    return date.toLocaleTimeString(options.locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  const sameYear = new Date(now).getFullYear() === date.getFullYear();
  return date.toLocaleDateString(options.locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** The full date and time, for tooltips and accessible labels. */
export function formatDateTime(
  value: Time,
  options: { locale?: string } = {},
): string {
  const at = time(value);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleString(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Relative time such as "5 minutes ago" or "in 2 hours", in the reader's locale. */
export function formatRelative(
  value: Time,
  options: { now?: Time; locale?: string } = {},
): string {
  const at = time(value);
  if (Number.isNaN(at)) return "";
  const now = time(options.now ?? Date.now());
  const seconds = Math.round((at - now) / 1000);
  const format = new Intl.RelativeTimeFormat(options.locale, {
    numeric: "auto",
  });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.35],
    ["month", 12],
    ["year", Infinity],
  ];
  let amount = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(amount) < size) {
      if (unit === "second" && Math.abs(amount) < 45) {
        return format.format(0, "second");
      }
      return format.format(Math.round(amount), unit);
    }
    amount /= size;
  }
  return format.format(Math.round(amount), "year");
}

/** Byte sizes in binary units: 512 B, 1.4 KB, 12 MB. */
export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** A compact count: 999, 1.2K, 3.4M. */
export function formatCount(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/** A clock duration such as 0:07 or 12:30. */
export function formatDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "0:00";
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Overridable English labels for the fixed recency buckets. */
export interface RecencyLabels {
  today?: string;
  yesterday?: string;
  week?: string;
  month?: string;
}

/**
 * The recency bucket for a list grouped by time: Today, Yesterday, Previous 7
 * days, Previous 30 days, then one bucket per month. Keys sort newest first
 * when compared as strings in reverse.
 */
export function recencyGroup(
  value: Time,
  options: { now?: Time; locale?: string; labels?: RecencyLabels } = {},
): Readonly<{ key: string; label: string }> {
  const at = time(value);
  const now = time(options.now ?? Date.now());
  const labels = options.labels ?? {};
  if (Number.isNaN(at)) return { key: "0-unknown", label: "" };
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days <= 0) return { key: "9-today", label: labels.today ?? "Today" };
  if (days === 1) {
    return { key: "8-yesterday", label: labels.yesterday ?? "Yesterday" };
  }
  if (days < 7) {
    return { key: "7-week", label: labels.week ?? "Previous 7 days" };
  }
  if (days < 30) {
    return { key: "6-month", label: labels.month ?? "Previous 30 days" };
  }
  const date = new Date(at);
  const sameYear = new Date(now).getFullYear() === date.getFullYear();
  const label = date.toLocaleDateString(options.locale, {
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const month = `${date.getFullYear()}-${
    String(date.getMonth() + 1).padStart(2, "0")
  }`;
  return { key: `5-${month}`, label };
}
