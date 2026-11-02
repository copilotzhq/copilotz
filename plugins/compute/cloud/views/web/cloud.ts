/**
 * Cloud computers on the web, their logic: the sizes offered and what they
 * cost while awake (as people pay: never what they cost the app), each
 * state as people read it, how long one has been awake and about what that
 * came to, how far along a wake is (an estimate, said as one), a name to
 * start from, and why making one was refused.
 */
import type { CloudComputer, CloudState } from "../../contract.ts";

/** The collection whose queries the views read: the person's (`mine`), and the sizes. */
export const COLLECTION = "cloudComputer";

/** A size, as `cloudComputer.sizes` offers it: `hour` is USD an hour awake, null when unpriced. */
export type Offered = {
  id: string;
  label: string;
  vcpu: number;
  memory: number;
  shared?: boolean;
  hour: number | null;
};

/** What `cloudComputer.sizes` answers: the sizes, and a new computer's disk and its storage's price. */
export type Sizes = {
  sizes: Offered[];
  disk: { gb: number; gbMonth: number | null; snapshotGbMonth: number | null };
  /** How long one stays awake unused, and while someone has it open (minutes). */
  warmMinutes: number;
  viewMinutes: number;
  /** Whether the person may make one now, and why not: guests don't, or the org can't spend. */
  create: boolean;
  why?: "guests" | "credits" | "budget";
  message?: string;
};

/** How long a computer stays awake after its last use, unless the app says otherwise. */
export const WARM_MINUTES = 10;
const VIEW_MINUTES = 120;

const minutesOf = (n: unknown, otherwise: number) =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? n : otherwise;

const price = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? n : null;

/** The sizes answer, whatever came: the sizes that make sense, and the disk (10 GB if unsaid). */
export function sizesOf(answer: unknown): Sizes {
  const said = (answer ?? {}) as Partial<
    Omit<Sizes, "sizes" | "disk"> & { sizes: unknown; disk: Partial<Sizes["disk"]> }
  >;
  const sizes = (Array.isArray(said.sizes) ? said.sizes : []).flatMap((s: Partial<Offered>) =>
    s && typeof s.id === "string" && typeof s.vcpu === "number" && typeof s.memory === "number"
      ? [{
        id: s.id,
        label: typeof s.label === "string" && s.label ? s.label : s.id,
        vcpu: s.vcpu,
        memory: s.memory,
        ...(s.shared ? { shared: true } : {}),
        hour: price(s.hour),
      }]
      : []
  );
  const disk = said.disk ?? {};
  return {
    sizes,
    disk: {
      gb: typeof disk.gb === "number" && disk.gb > 0 ? disk.gb : 10,
      gbMonth: price(disk.gbMonth),
      snapshotGbMonth: price(disk.snapshotGbMonth),
    },
    warmMinutes: minutesOf(said.warmMinutes, WARM_MINUTES),
    viewMinutes: minutesOf(said.viewMinutes, VIEW_MINUTES),
    // An app that doesn't say lets anyone try: `cloud.create` says if not.
    create: said.create !== false,
    ...(said.create === false &&
        (said.why === "guests" || said.why === "credits" || said.why === "budget")
      ? { why: said.why, ...(typeof said.message === "string" ? { message: said.message } : {}) }
      : {}),
  };
}

/** USD as people read a price: two decimals, or three below a dime ($0.034). */
export function money(usd: number): string {
  if (usd > 0 && usd < 0.1) return `$${usd.toFixed(3).replace(/0$/, "")}`;
  return `$${usd.toFixed(2)}`;
}

/** What something came to so far: under a cent, or about its price. */
export const spent = (usd: number): string => usd < 0.01 ? "under 1¢" : `about $${usd.toFixed(2)}`;

/** A size's machine, in a line: "2 vCPU · 4 GB". */
export const specsOf = (s: Pick<Offered, "vcpu" | "memory">): string =>
  `${s.vcpu} vCPU · ${s.memory} GB`;

/** A state as people read it: its label, its badge's tone, whether it's on its way, and what it means. */
export type Look = {
  label: string;
  tone: "neutral" | "success" | "info";
  busy: boolean;
  hint: string;
};

const LOOKS: Record<CloudState, Look> = {
  awake: {
    label: "Awake",
    tone: "success",
    busy: false,
    hint: "It's running: you pay while it's awake",
  },
  asleep: {
    label: "Asleep",
    tone: "neutral",
    busy: false,
    hint: "It wakes when it's used, in a few seconds",
  },
  cold: {
    label: "Sleeping deeply",
    tone: "neutral",
    busy: false,
    hint: "Unused for a while: waking takes about half a minute",
  },
  waking: { label: "Waking", tone: "info", busy: true, hint: "Usually a few seconds" },
  releasing: {
    label: "Going to sleep",
    tone: "neutral",
    busy: true,
    hint: "It stops, then can wake again in a moment",
  },
};

export const lookOf = (state: CloudState): Look => LOOKS[state] ?? LOOKS.asleep;

/** A duration as people say it: "less than a minute", "12 min", "1 h 5 min". */
export function duration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** How long it's been awake this time, while it's awake (from when it woke). */
export function awakeFor(
  record: Pick<CloudComputer, "state" | "woke">,
  now: number,
): number | undefined {
  if (record.state !== "awake" || !record.woke) return undefined;
  const woke = Date.parse(record.woke);
  return Number.isNaN(woke) ? undefined : Math.max(0, now - woke);
}

/** About what its time awake came to, at its size's price an hour (none unpriced). */
export const costOf = (ms: number, hour: number | null): number | undefined =>
  hour === null ? undefined : hour * ms / 3_600_000;

/** How long a wake usually takes: from asleep, a few seconds; from cold, about half a minute. */
export const WAKE_MS = { asleep: 6_000, cold: 30_000 } as const;

/**
 * How far along a wake looks, from 0 to 0.95: quick at first, then slower,
 * never done until it is (about 80% at the usual time).
 */
export const progress = (elapsed: number, expected: number): number =>
  Math.min(0.95, 1 - Math.exp(-1.6 * Math.max(0, elapsed) / Math.max(1, expected)));

/**
 * Whether a call failed only for now, so it's asked again soon: the
 * computer is still waking, or the call didn't reach the app (or its
 * answer didn't come back) while a long wake went on there.
 */
export const stillWaking = (error: unknown): boolean => {
  const said = error instanceof Error ? error.message : String(error ?? "");
  if ((error as { code?: string })?.code === "unavailable") return /\bwaking\b/i.test(said);
  return error instanceof TypeError &&
    /failed to fetch|networkerror|load failed|network/i.test(said);
};

/** Why making one was refused, when it's who may (`forbidden`) or the month's budget (`budget`). */
export function refusalOf(error: unknown): "forbidden" | "credits" | "budget" | undefined {
  const code = (error as { code?: string })?.code;
  return code === "forbidden" || code === "credits" || code === "budget" ? code : undefined;
}

/** A name to start from, for a new one in a space. */
export const suggestedName = (where?: string): string =>
  where && where !== "Personal" ? `${where} cloud` : "My cloud computer";
