/**
 * The org's usage (kind `usage.org`, a section of the org's page, the web
 * shell's `orgSettings`), where the app serves many orgs. Whoever pays opens
 * it to know how much, whether that's normal, how long until the budget or
 * the credits run out, and what's driving it; everyone else, for their own
 * use; staff, for cost and margin. So, top to bottom:
 *
 * 1. One line: what was spent this month (the billing month: the budget's),
 *    against the budget, what's left and about how long it lasts at this
 *    pace, the change against the same point last month, and what caching
 *    saved, with a way to Billing. Past months to pick. Without the credits
 *    plugin (no `billing.state`), calendar months and spend alone.
 * 2. One switch (kind, space, person, agent, model) for a daily chart
 *    stacked by it and a list ranked by it. Choosing a row keeps the whole
 *    page to it (a chip, removed with ×); the list and chart still show its
 *    neighbours, the chosen one forward. A model's row says its tokens,
 *    calls and cache.
 * 3. Activity, kept to the same chips: turns, computers' sessions, apps'
 *    days and conversations' upkeep, newest first; a turn opens to its
 *    model calls.
 *
 * Its owners and admins see everyone's (`usage.org`, `usage.activity`), or
 * just theirs; anyone else, their own. Every amount is a price: what people
 * are charged (a call on the org's own key or a connected plan says so,
 * rather than $0). Platform staff alone see what it cost too, and so the
 * margin (the answers say so: `costs`), in the staff colour.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  IconButton,
  type IconName,
  message,
  Notice,
  Select,
  Skeleton,
  Tabs,
  Time,
} from "../../../../../hosts/web/mod.ts";
import { runs, type Standing } from "../../../../interfaces/web/contract.ts";
import type { ActivityCall, ActivityItem } from "../../actions/activity.ts";
import { type Series, StackedChart } from "./chart.tsx";
import {
  agentName,
  change,
  changeSaid,
  columnsOf,
  compact,
  daysIn,
  type Dimension,
  dimensionIn,
  dimensionName,
  DIMENSIONS,
  durationSaid,
  hitRate,
  lastsSaid,
  marginOf,
  modelOf,
  monthAt,
  monthBefore,
  monthOf,
  monthProgress,
  monthSaid,
  percent,
  purposeSaid,
  type Row,
  rowsOf,
  samePointBefore,
  SERIES,
  type Sum,
  sumOf,
  type Total,
  usd,
} from "./numbers.ts";
import { STYLE } from "./style.ts";
import { say } from "./words.ts";
import { formatDate, formatNumber, formatTime } from "../../../../../hosts/web/mod.ts";
import { nameOf as personName } from "../../../../access/spaces/contract.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Org = { id: string; name: string; kind: string };
type Person = { person: string; name?: string; email?: string; picture?: string };
type Named = Record<string, Record<string, { name: string; owner?: string }>>;
type Filter = Record<string, unknown>;

/** What `billing.state` answers that this page reads (the credits plugin's; absent without it). */
export type Billing = {
  on: boolean;
  runs: boolean;
  balance?: number;
  waived?: boolean;
  month?: { start: string; end: string; spent: number; limit?: number };
};

/** A chip: the page kept to one row of a dimension. */
type Chip = { dimension: Dimension; key: string; label: string; filter: Filter };

type Report = {
  /** The month by day and the dimension, kept to every chip but the dimension's own. */
  totals: Total[];
  names: Named;
  /** The same point (or the whole) of the month before, kept to every chip. */
  before: number;
  all: boolean;
  costs: boolean;
};

export type Activity = { items: ActivityItem[]; more: boolean; names: Named };

const FIRST = 20;
const MORE = 30;

/** Kinds in the order their colours keep, whatever each spent. */
const KINDS = ["agents", "computers", "apps"];
const KIND: Record<string, { name: () => string; icon: IconName }> = {
  agents: { name: () => say("kindAgents"), icon: "bot" },
  computers: { name: () => say("kindComputers"), icon: "computer" },
  apps: { name: () => say("kindApps"), icon: "globe" },
};

export const orgUsageView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const org = ctx.hints.org as Org | undefined;
  const standing = {
    role: (ctx.hints.role as string | null | undefined) ?? null,
    staff: ctx.hints.staff === true,
  };
  return (
    <>
      <style href="usage-web" precedence="copilotz">{STYLE}</style>
      <Usage org={org} standing={standing} me={ctx.viewer?.name} call={ctx.call} />
    </>
  );
};

/** Filters merged: each chip's, the later over the earlier. */
const merged = (chips: Chip[]): Filter => Object.assign({}, ...chips.map((c) => c.filter));

function Usage(
  { org, standing, me, call }: { org?: Org; standing: Standing; me?: string; call: Call },
): ReactNode {
  const manage = runs(standing);
  const personal = org?.kind === "personal";
  const now = Date.now();
  const [billing, setBilling] = useState<Billing | null>();
  // The billing month: the budget's, as the credits plugin says; else the calendar's.
  const current = billing?.month ? monthAt(`${billing.month.start}T00:00:00Z`) : monthAt(now);
  const [picked, setMonth] = useState<string>();
  const month = picked ?? current;
  const [whose, setWhose] = useState<"all" | "mine">("all");
  const [dimension, setDimension] = useState<Dimension>("kind");
  const [chips, setChips] = useState<Chip[]>([]);
  const [limit, setLimit] = useState(FIRST);
  const [months, setMonths] = useState<Total[]>();
  const [report, setReport] = useState<Report>();
  const [activity, setActivity] = useState<Activity>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [people, setPeople] = useState<Map<string, Person>>(new Map());
  const [asked, ask] = useState(0);
  const mine: Filter = (whose === "mine" || !manage) && me ? { "tags.person": me } : {};
  const { start, end } = monthOf(month);
  const within = { at: { $gte: start, $lt: end } };
  const ongoing = month === monthAt(now);

  // Where the org stands, when the credits plugin is there.
  useEffect(() => {
    call<Billing>("billing.state", {}).then(setBilling, () => setBilling(null));
  }, [asked]);

  // The months there's usage in, for picking one.
  useEffect(() => {
    call<{ totals: Total[] }>("usage.org", { filter: mine, by: ["month"] }).then(
      (found) => setMonths(found.totals),
      () => setMonths([]),
    );
  }, [whose, asked]);

  // The month by the dimension, and the month before (to the same point), kept to the chips.
  useEffect(() => {
    let live = true;
    setLoading(true);
    const others = merged(chips.filter((c) => c.dimension !== dimension));
    const all = merged(chips);
    const previous = monthOf(monthBefore(month));
    Promise.all([
      call<{ totals: Total[]; names: Named; all: boolean; costs?: boolean }>("usage.org", {
        filter: { ...others, ...mine, ...within },
        by: ["day", ...DIMENSIONS[dimension].by],
      }),
      call<{ totals: Total[] }>("usage.org", {
        filter: {
          ...all,
          ...mine,
          at: {
            $gte: previous.start,
            $lt: ongoing ? samePointBefore(month, now) : previous.end,
          },
        },
      }),
    ]).then(([found, before]) => {
      if (!live) return;
      setReport({
        totals: found.totals,
        names: found.names ?? {},
        before: sumOf(before.totals).spend,
        all: found.all && whose === "all",
        costs: found.costs === true,
      });
      setError(undefined);
      setLoading(false);
    }, (e) => {
      if (!live) return;
      setError(message(e));
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [month, whose, dimension, chips, asked]);

  // What was done, kept to every chip.
  useEffect(() => {
    let live = true;
    call<Activity>("usage.activity", { filter: { ...merged(chips), ...mine, ...within }, limit })
      .then((found) => live && setActivity(found), () => live && setActivity(undefined));
    return () => {
      live = false;
    };
  }, [month, whose, chips, limit, asked]);

  // Whose each person's usage is, by name and face: the org's people (for those who run it).
  useEffect(() => {
    if (!manage || personal) return;
    call<{ people: Person[] }>("org.people", {}).then(
      (found) => setPeople(new Map(found.people.map((p) => [p.person, p]))),
      () => {},
    );
  }, [manage]);

  // Coming back to the page, it's read again: usage grows as agents work.
  useEffect(() => {
    const again = () => document.visibilityState === "visible" && ask((n) => n + 1);
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, []);

  const models = useModelNames(call, [
    ...(report?.totals ?? []).map((t) => t.key.subject),
    ...(activity?.items ?? []).flatMap((
      i,
    ) => [i.subject, ...(i.calls ?? []).map((c) => c.subject)]),
  ]);

  const names: Named = { ...report?.names, ...activity?.names };
  for (const field of Object.keys(activity?.names ?? {})) {
    names[field] = { ...report?.names[field], ...activity?.names[field] };
  }
  const nameOf = (person: string) =>
    !person
      ? say("notTiedToAnyone")
      : person === me
      ? say("you")
      : people.get(person)?.name || people.get(person)?.email || personName(person);
  /** Whose face: their own name's, even when it says "You". */
  const faceOf = (person: string) => people.get(person)?.name || personName(person);
  const spaceOf = (space: string) => {
    if (!space) return say("spaceNotRecorded");
    const found = nameIn(names, "tags.space", space);
    if (!found) return say("spaceNotReached");
    if (!found.owner) return found.name;
    return found.owner === me
      ? say("yourPersonalSpace")
      : say("personalSpaceOf", { name: faceOf(found.owner) });
  };
  const modelName = (subject: string) => models.get(subject) ?? modelOf(subject).name;
  const namer: Sayers = { nameOf, faceOf, spaceOf, modelName, people, names };

  const choose = (row: Row, label: string) =>
    setChips((had) => {
      const same = had.find((c) => c.dimension === dimension && c.key === row.key);
      if (same) return had.filter((c) => c !== same);
      const keys = Object.keys(row.filter);
      // A chip replaces those it contradicts: its own dimension's, and any on the same fields.
      const kept = had.filter((c) =>
        c.dimension !== dimension && !Object.keys(c.filter).some((k) => keys.includes(k))
      );
      return [...kept, { dimension, key: row.key, label, filter: row.filter }];
    });
  useEffect(() => setLimit(FIRST), [month, whose, chips]);

  if (error && !report) {
    return (
      <Notice
        tone="destructive"
        role="alert"
        action={<Button size="sm" onClick={() => ask((n) => n + 1)}>{say("tryAgain")}</Button>}
      >
        {say("readError", { error })}
      </Notice>
    );
  }

  const choices = [...new Set([current, ...(months ?? []).map((t) => String(t.key.month))])]
    .filter((m) => m && m <= current).sort().reverse();
  const spentIn = new Map((months ?? []).map((t) => [String(t.key.month), t.price]));
  const filters = (
    <div className="usage-filters">
      <Select
        aria-label={say("month")}
        className="usage-period"
        value={month}
        onChange={(event) => setMonth(event.target.value)}
      >
        {choices.map((m) => (
          <option key={m} value={m}>
            {/* This month's spend is the headline's; past months say theirs (this year's, short). */}
            {m === current ? say("thisMonth") : monthSaid(m, m.slice(0, 4) === current.slice(0, 4))}
            {m !== current && spentIn.get(m) ? ` · ${usd(spentIn.get(m)!)}` : ""}
          </option>
        ))}
      </Select>
      {manage && !personal
        ? (
          <Select
            aria-label={say("whoseUsage")}
            className="usage-whose-pick"
            value={whose}
            onChange={(event) => setWhose(event.target.value as typeof whose)}
          >
            <option value="all">{say("everyone")}</option>
            <option value="mine">{say("justYou")}</option>
          </Select>
        )
        : null}
      <span className="usage-filters-gap" />
      <IconButton
        icon="refresh"
        label={say("readAgain")}
        loading={loading && !!report}
        onClick={() => ask((n) => n + 1)}
      />
    </div>
  );
  if (!report || billing === undefined) {
    return (
      <div className="usage" aria-busy="true">
        {filters}
        <div className="usage-head">
          <Skeleton height={34} width="40%" radius="md" />
          <Skeleton height={18} width="70%" radius="md" />
        </div>
        <Skeleton height={420} radius="xl" />
        <Skeleton height={220} radius="xl" />
      </div>
    );
  }

  const everyone = report.all;
  const staff = report.costs;
  const rows = rowsOf(report.totals, dimension);
  const chosen = chips.find((c) => c.dimension === dimension);
  const kept = chosen ? rows.filter((r) => r.key === chosen.key) : rows;
  const spent: Sum = kept.reduce((into, r) => {
    into.spend += r.spend;
    into.saved += r.saved;
    into.uses += r.uses;
    into.unpriced += r.unpriced;
    if (r.cost !== undefined) into.cost = (into.cost ?? 0) + r.cost;
    return into;
  }, { ...sumOf([]) });
  const whole = spentIn.get(month) ?? 0;
  return (
    <div className="usage" data-loading={loading || undefined}>
      {filters}
      {!manage
        ? (
          <p className="usage-whose">
            <Icon name="person" size={14} />
            {say("ownUsage")}
          </p>
        )
        : null}
      <Headline
        spent={spent}
        before={report.before}
        month={month}
        ongoing={ongoing}
        now={now}
        everyone={everyone}
        filtered={chips.length > 0}
        whole={whole}
        staff={staff}
        billing={billing && everyone && !chips.length && month === current ? billing : undefined}
        manage={manage}
      />
      {chips.length
        ? (
          <div className="usage-chips" aria-label={say("keptTo")}>
            <span className="usage-chips-label">{say("showingOnly")}</span>
            {chips.map((chip) => (
              <span key={`${chip.dimension}:${chip.key}`} className="usage-chip">
                <span className="usage-chip-what">
                  {say("chipWhat", { what: dimensionName(chip.dimension) })}
                </span>
                <span className="usage-chip-name">{chip.label}</span>
                <button
                  type="button"
                  className="usage-chip-x"
                  aria-label={say("showAllNotOnly", { name: chip.label })}
                  onClick={() => setChips(chips.filter((c) => c !== chip))}
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
            {chips.length > 1
              ? (
                <Button size="sm" variant="ghost" onClick={() => setChips([])}>
                  {say("showEverything")}
                </Button>
              )
              : null}
          </div>
        )
        : null}
      {report.totals.length || chips.length
        ? (
          <Breakdown
            rows={rows}
            totals={report.totals}
            dimension={dimension}
            setDimension={setDimension}
            month={month}
            today={ongoing ? new Date(now).toISOString().slice(0, 10) : undefined}
            chosen={chosen?.key}
            choose={choose}
            staff={staff}
            everyone={everyone}
            namer={namer}
          />
        )
        : (
          <Card className="usage-empty">
            <EmptyState
              icon="chart"
              title={ongoing
                ? say("nothingUsedThisMonth")
                : say("nothingUsedIn", { month: monthSaid(month) })}
            >
              {everyone ? say("emptyEveryone") : say("emptyOwn")}
            </EmptyState>
          </Card>
        )}
      {activity && (activity.items.length || report.totals.length)
        ? (
          <ActivityCard
            activity={activity}
            everyone={everyone}
            staff={staff}
            namer={namer}
            more={() => setLimit((n) => n + MORE)}
            filtered={chips.length > 0}
          />
        )
        : null}
      {spent.unpriced
        ? (
          <p className="usage-unpriced">
            <Icon name="info" size={14} />
            <span>
              {say("unpriced", { count: spent.unpriced, total: formatNumber(spent.unpriced) })}
            </span>
          </p>
        )
        : null}
    </div>
  );
}

/**
 * A tag's value by name, as the answers say it: none when it's named but out
 * of the caller's reach; itself, as a name, when no plugin names that tag.
 */
function nameIn(
  names: Named,
  tag: string,
  id: string,
): { name: string; owner?: string } | undefined {
  const named = names[tag];
  return named ? named[id] : { name: id };
}

/** How the page names things: people, spaces, models, and the tags `names` covers. */
export type Sayers = {
  nameOf(person: string): string;
  faceOf(person: string): string;
  spaceOf(space: string): string;
  modelName(subject: string): string;
  people: Map<string, Person>;
  names: Named;
};

/** Models by name, as the models plugin offers them (`models.offered`): asked once each. */
function useModelNames(call: Call, subjects: unknown[]): Map<string, string> {
  const known = useRef(new Map<string, string>());
  const [, redraw] = useState(0);
  const wanted = [...new Set(subjects)].filter((s): s is string =>
    typeof s === "string" && s.includes("/") && !known.current.has(s)
  );
  const key = wanted.sort().join(",");
  useEffect(() => {
    if (!wanted.length) return;
    for (const subject of wanted) known.current.set(subject, modelOf(subject).name);
    Promise.all(
      wanted.map((model) =>
        call<{ model?: { name?: string } | null }>("models.offered", { model }).then(
          (found) => found.model?.name && known.current.set(model, found.model.name),
          () => {},
        )
      ),
    ).then(() => redraw((n) => n + 1));
  }, [key]);
  return known.current;
}

/** Which way a change went, as an arrow. */
const ARROWS = { up: "↑", down: "↓", flat: "→" };

/**
 * The headline: what was spent, against the budget, what's left and about
 * how long it lasts at this pace; the change against the same point of the
 * month before; what caching saved; the way to Billing. Staff, the cost and
 * the margin.
 */
export function Headline(
  { spent, before, month, ongoing, now, everyone, filtered, whole, staff, billing, manage }: {
    spent: Sum;
    before: number;
    month: string;
    ongoing: boolean;
    now: number;
    everyone: boolean;
    filtered: boolean;
    whole: number;
    staff: boolean;
    billing?: Billing;
    manage: boolean;
  },
): ReactNode {
  const spentSaid = say(
    everyone
      ? ongoing ? "spentThisMonth" : "spentIn"
      : ongoing
      ? "spentByYouThisMonth"
      : "spentByYouIn",
    { month: monthSaid(month) },
  );
  const delta = change(spent.spend, before);
  const way = delta === undefined
    ? undefined
    : delta > 0.005
    ? "up"
    : delta < -0.005
    ? "down"
    : "flat";
  const against = ongoing ? say("pointLastMonth") : monthSaid(monthBefore(month));
  // What's left, and how long it lasts: the budget's or the credits', whichever ends first.
  const charged = billing?.on && !billing.waived ? billing : undefined;
  const limit = charged?.month?.limit;
  const counted = charged?.month?.spent ?? spent.spend;
  const { elapsed, days } = monthProgress(month, now);
  const perDay = counted / Math.max(elapsed, 1);
  const budgetLeft = limit !== undefined ? limit - counted : undefined;
  const credits = charged?.balance;
  const binding = budgetLeft !== undefined && (credits === undefined || budgetLeft <= credits)
    ? { what: "budget" as const, left: budgetLeft }
    : credits !== undefined
    ? { what: "credits" as const, left: credits }
    : undefined;
  const lasts = binding && lastsSaid(binding.left, perDay);
  const monthLeft = days - elapsed;
  const share = limit ? counted / limit : undefined;
  const tone = binding && binding.left <= 0
    ? "out"
    : share !== undefined && share >= 0.8
    ? "near"
    : undefined;
  const leftSaid = !binding
    ? null
    : binding.left <= 0
    ? (
      <span className="usage-left" data-tone="out">
        <Icon name="alert" size={13} />
        {binding.what === "budget" ? say("budgetUsedUp") : say("outOfCredits")}
      </span>
    )
    : (
      <span className="usage-left" data-tone={tone}>
        {binding.what === "credits"
          ? say(lasts ? "creditsLeftLasts" : "creditsLeft", {
            amount: usd(binding.left),
            lasts: lasts ?? "",
          })
          : lasts && binding.left / perDay >= monthLeft
          ? say("budgetLeftEnough", { amount: usd(binding.left) })
          : say(lasts ? "budgetLeftLasts" : "budgetLeft", {
            amount: usd(binding.left),
            lasts: lasts ?? "",
          })}
      </span>
    );
  return (
    <section className="usage-head" aria-label={say("thisMonth")}>
      <p className="usage-headline">
        <b className="usage-amount">{usd(spent.spend)}</b> <span>{spentSaid}</span>
        {filtered && whole > 0
          ? (
            <span className="usage-dot">
              {say("shareOfAll", { percent: percent(spent.spend / whole) })}
            </span>
          )
          : null}
        {limit !== undefined
          ? (
            <span className="usage-dot">
              {say("shareOfBudget", { percent: percent(share), limit: usd(limit) })}
            </span>
          )
          : null}
        {leftSaid ? <span className="usage-dot">{leftSaid}</span> : null}
      </p>
      {limit !== undefined
        ? (
          <div
            className="usage-meter-budget"
            data-tone={tone}
            role="meter"
            aria-label={say("meterLabel")}
            aria-valuemin={0}
            aria-valuemax={limit}
            aria-valuenow={Math.min(counted, limit)}
            aria-valuetext={say("meterValue", { spent: usd(counted), limit: usd(limit) })}
          >
            <span style={{ width: `${Math.min(1, share ?? 0) * 100}%` }} />
            {ongoing
              ? (
                <i
                  className="usage-meter-now"
                  style={{ left: `${(elapsed / days) * 100}%` }}
                  title={say("meterNow")}
                />
              )
              : null}
          </div>
        )
        : null}
      <p className="usage-subline">
        {way
          ? (
            <span className="usage-delta" data-way={way}>
              {ARROWS[way]} {changeSaid(delta!)} <span>{say("versus", { against })}</span>
            </span>
          )
          : spent.spend > 0
          ? <span>{ongoing ? say("nothingByPoint") : say("nothingIn", { against })}</span>
          : null}
        {spent.saved > 0
          ? <span className="usage-dot">{say("cachingSaved", { amount: usd(spent.saved) })}</span>
          : spent.saved < 0
          ? <span className="usage-dot">{say("cachingCost", { amount: usd(-spent.saved) })}</span>
          : null}
        {manage && billing
          ? (
            <a className="usage-billing" href="/org?tab=billing">
              {say("billing")} <span aria-hidden="true">→</span>
            </a>
          )
          : null}
      </p>
      {staff
        ? (
          <p className="usage-staff-line">
            <Badge tone="warning">
              <Icon name="shield" size={12} />
              {say("staffOnly")}
            </Badge>
            <span>{say.nodes("costOf", { amount: <b>{usd(spent.cost ?? 0)}</b> })}</span>
            <span className="usage-dot">
              {say.nodes("marginOf", {
                percent: <b>{percent(marginOf(spent.spend, spent.cost))}</b>,
              })}
            </span>
            <span className="usage-dot">
              {say(spent.spend < (spent.cost ?? 0) ? "underCost" : "overCost", {
                amount: usd(Math.abs(spent.spend - (spent.cost ?? 0))),
              })}
            </span>
          </p>
        )
        : null}
    </section>
  );
}

/** A row's colour in the chart: the series it is, or the rest's grey. */
const colorOf = (i: number | undefined) =>
  i === undefined || i >= SERIES ? "var(--usage-other)" : `var(--chart-${i + 1}, var(--primary))`;

/** Shown at first, of a long list: the rest a press away. */
const SHOWN = 8;

/**
 * The switch, the stacked chart and the ranked list: one dimension for
 * both. Choosing a row keeps the page to it.
 */
export function Breakdown(
  {
    rows,
    totals,
    dimension,
    setDimension,
    month,
    today,
    chosen,
    choose,
    staff,
    everyone,
    namer,
  }: {
    rows: Row[];
    totals: Total[];
    dimension: Dimension;
    setDimension(d: Dimension): void;
    month: string;
    today?: string;
    chosen?: string;
    choose(row: Row, label: string): void;
    staff: boolean;
    everyone: boolean;
    namer: Sayers;
  },
): ReactNode {
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [dimension]);
  // Series: kinds in their own order (each keeps its colour); else the largest first.
  const ordered = dimension === "kind"
    ? [...rows].sort((a, b) =>
      (KINDS.indexOf(a.key) + 1 || 99) - (KINDS.indexOf(b.key) + 1 || 99) || b.spend - a.spend
    )
    : [...rows];
  // The chosen row is drawn in a colour of its own, however small: the last series' place.
  const at0 = ordered.findIndex((r) => r.key === chosen);
  if (at0 >= SERIES) ordered.splice(SERIES - 1, 0, ...ordered.splice(at0, 1));
  const many = ordered.length > SERIES;
  const series: Series[] = [
    ...ordered.slice(0, SERIES).map((r, i) => ({
      key: r.key,
      name: label(dimension, r, namer),
      color: colorOf(i),
    })),
    ...(many ? [{ key: "*", name: say("theRest"), color: colorOf(SERIES) }] : []),
  ];
  const at = new Map(series.map((s, i) => [s.key, i]));
  const days = useMemo(() => daysIn(month), [month]);
  const columns = useMemo(
    () => columnsOf(totals, dimension, days, series.slice(0, SERIES).map((s) => s.key)),
    [totals, dimension, days, series.map((s) => s.key).join()],
  );
  const pick = chosen === undefined ? undefined : at.get(chosen) ?? (many ? SERIES : undefined);
  const dims = Object.entries(DIMENSIONS).filter(([d]) => everyone || d !== "person");
  const shown = all ? rows : rows.slice(0, SHOWN);
  const per = dimensionIn(dimension);
  return (
    <Card as="section" className="usage-card usage-by" aria-labelledby="usage-by">
      <header className="usage-card-head usage-by-head">
        <h3 id="usage-by">{say("spendBy")}</h3>
        <Tabs
          label={say("spendBy")}
          value={dimension}
          onChange={setDimension}
          tabs={dims.map(([value]) => ({
            value: value as Dimension,
            label: dimensionName(value as Dimension),
          }))}
        />
      </header>
      <StackedChart
        columns={columns}
        series={series}
        today={today}
        chosen={pick}
        label={say("chartLabel", { month: monthSaid(month), by: per })}
      />
      <ul className="usage-rows" aria-label={say("rowsLabel", { by: per })}>
        {shown.map((row) => {
          const name = label(dimension, row, namer);
          const on = row.key === chosen;
          const i = at.get(row.key) ?? (many ? SERIES : undefined);
          return (
            <li key={row.key}>
              <button
                type="button"
                className="usage-row"
                aria-pressed={on}
                data-back={chosen !== undefined && !on || undefined}
                onClick={() => choose(row, name)}
                title={on ? say("showAllAgain") : say("seeOnly", { name })}
              >
                <i className="usage-swatch" style={{ background: colorOf(i) }} aria-hidden="true" />
                {face(dimension, row, namer)}
                <span className="usage-row-text">
                  <span className="usage-row-name">
                    <span className="usage-row-label">{name}</span>
                    {detailOf(dimension, row, namer)
                      ? <span className="usage-row-detail">{detailOf(dimension, row, namer)}</span>
                      : null}
                  </span>
                  <span className="usage-row-meter" aria-hidden="true">
                    <span
                      style={{
                        width: `${Math.max(row.share * 100, row.share ? 1.5 : 0)}%`,
                        background: colorOf(i),
                      }}
                    />
                  </span>
                  {dimension === "model" && row.key.startsWith("subject:")
                    ? <span className="usage-row-more">{modelDetail(row)}</span>
                    : null}
                  {staff && row.cost !== undefined
                    ? (
                      <span className="usage-row-staff">
                        <Icon name="shield" size={11} />
                        {marginOf(row.spend, row.cost) !== undefined
                          ? say("rowCostMargin", {
                            amount: usd(row.cost),
                            percent: percent(marginOf(row.spend, row.cost)),
                          })
                          : say("rowCost", { amount: usd(row.cost) })}
                      </span>
                    )
                    : null}
                </span>
                <span className="usage-row-value">
                  {usd(row.spend)}
                  <span className="usage-row-share">{percent(row.share)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {rows.length > SHOWN
        ? (
          <Button size="sm" variant="ghost" className="usage-more" onClick={() => setAll(!all)}>
            {all ? say("showFewer") : say("showAll", { count: rows.length })}
          </Button>
        )
        : null}
    </Card>
  );
}

/** A model's row, in detail: its tokens, calls and how much input came from a cache. */
function modelDetail(row: Row): string {
  const hit = hitRate(row.cached, row.input);
  return [
    say("tokens", { tokens: compact(row.tokens) }),
    say("calls", { count: row.uses, calls: compact(row.uses) }),
    hit !== undefined ? say("fromInputCache", { percent: percent(hit) }) : null,
    row.saved > 0 ? say("cachingSaved", { amount: usd(row.saved) }) : null,
  ].filter(Boolean).join(" · ");
}

/** A kind by name: Agents, Computers, Apps, or an app's own meter. */
const kindName = (kind: string) => KIND[kind]?.name() ?? agentName(kind);

/** A row's name in its dimension. */
function label(dimension: Dimension, row: Row, namer: Sayers): string {
  const [what, ...rest] = row.key.split(":");
  const value = rest.join(":");
  switch (dimension) {
    case "kind":
      return kindName(row.key);
    case "space":
      return namer.spaceOf(row.key);
    case "person":
      return namer.nameOf(row.key);
    case "agent":
      return what === "agent"
        ? agentName(value)
        : what === "upkeep"
        ? say("conversationUpkeep")
        : what === "purpose"
        ? purposeSaid(value)
        : what === "category"
        ? kindName(value)
        : say("otherModelUse");
    case "model":
      return what === "subject" ? namer.modelName(value) : kindName(value);
  }
}

/** What a row is, said beside its name, where its name doesn't say it all. */
function detailOf(dimension: Dimension, row: Row, _say: Sayers): string | undefined {
  const [what, ...rest] = row.key.split(":");
  if (dimension === "agent" && what === "upkeep") return say("upkeepDetail");
  if (dimension === "model" && what === "subject") return modelOf(rest.join(":")).provider;
  if (dimension === "space" && !row.key) return say("beforeSpaces");
  return undefined;
}

/** A row's face: a person's or agent's avatar, a space's, or its kind's icon. */
function face(dimension: Dimension, row: Row, namer: Sayers): ReactNode {
  const [what, ...rest] = row.key.split(":");
  const value = rest.join(":");
  const icon = (name: IconName, className = "usage-face") => (
    <span className={className} aria-hidden="true">
      <Icon name={name} size={14} />
    </span>
  );
  switch (dimension) {
    case "kind":
      return icon(KIND[row.key]?.icon ?? "tool");
    case "space":
      return row.key
        ? <Avatar name={namer.spaceOf(row.key)} kind="space" size={26} />
        : icon("info");
    case "person":
      return row.key
        ? (
          <Avatar
            name={namer.faceOf(row.key)}
            picture={namer.people.get(row.key)?.picture}
            size={26}
          />
        )
        : icon("settings");
    case "agent":
      return what === "agent"
        ? <Avatar name={value} kind="agent" size={26} />
        : what === "category"
        ? icon(KIND[value]?.icon ?? "tool")
        : icon("note");
    case "model":
      return what === "subject"
        ? icon("sparkles", "usage-face usage-face-model")
        : icon(KIND[value]?.icon ?? "tool");
  }
}

/**
 * A use the org wasn't charged for because someone else pays for it: on its
 * own key, or a person's plan. Said as what it is, rather than $0.
 */
export const paidBy = (
  tags: Record<string, string> | undefined,
): { label: string; title: string } | undefined =>
  tags?.paid === "own-key"
    ? { label: say("yourKey"), title: say("yourKeyTitle") }
    : tags?.paid === "subscription"
    ? { label: say("plan"), title: say("planTitle") }
    : undefined;

/** What it was charged, as a list says it: who else paid, nothing known, or its price. */
function Price(
  { price, paid, unpriced, cost, staff }: {
    price: number;
    paid?: string;
    unpriced?: boolean;
    cost?: number;
    staff: boolean;
  },
): ReactNode {
  const other = paidBy(paid ? { paid } : undefined);
  return (
    <span className="usage-price">
      {other
        ? <span className="usage-quiet" title={other.title}>{other.label}</span>
        : unpriced && !price
        ? <span className="usage-quiet" title={say("noKnownCost")}>—</span>
        : usd(price, true)}
      {staff && cost !== undefined
        ? (
          <span className="usage-price-staff" title={say("staffCostMargin")}>
            {usd(cost, true)} · {percent(marginOf(price, cost))}
          </span>
        )
        : null}
    </span>
  );
}

/** The time of a day, as the clock says it: "14:05". */
const clock = (at: string, seconds = false) =>
  formatTime(new Date(at), {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });

/** A day, short: "Nov 2". */
const dayShort = (at: string) =>
  formatDate(new Date(at.length === 10 ? `${at}T12:00:00Z` : at), {
    month: "short",
    day: "numeric",
  });

/** What was done, newest first, kept to the same chips. */
export function ActivityCard(
  { activity, everyone, staff, namer, more, filtered }: {
    activity: Activity;
    everyone: boolean;
    staff: boolean;
    namer: Sayers;
    more(): void;
    filtered: boolean;
  },
): ReactNode {
  return (
    <Card
      as="section"
      padding="none"
      className="usage-card usage-activity"
      aria-labelledby="usage-activity"
    >
      <header className="usage-card-head usage-activity-head">
        <h3 id="usage-activity">{say("activity")}</h3>
        <p>
          {staff ? <Badge tone="warning">{say("staffCostMargin")}</Badge> : null}
          {say(
            everyone
              ? filtered ? "activityEveryoneFiltered" : "activityEveryone"
              : filtered
              ? "activityYoursFiltered"
              : "activityYours",
          )}
        </p>
      </header>
      {activity.items.length
        ? (
          <ul className="usage-items">
            {activity.items.map((item) => (
              <Item key={item.id} item={item} everyone={everyone} staff={staff} namer={namer} />
            ))}
          </ul>
        )
        : <p className="usage-none">{say("nothingMatches")}</p>}
      {activity.more
        ? (
          <Button size="sm" variant="ghost" className="usage-more usage-more-items" onClick={more}>
            {say("showOlder")}
          </Button>
        )
        : null}
    </Card>
  );
}

/** A thing done: its time, what it was in words, its details, what it was charged. */
function Item(
  { item, everyone, staff, namer }: {
    item: ActivityItem;
    everyone: boolean;
    staff: boolean;
    namer: Sayers;
  },
): ReactNode {
  const [open, setOpen] = useState(false);
  const t = item.tags;
  const thread = t.thread ? nameIn(namer.names, "tags.thread", t.thread)?.name : undefined;
  const where = thread ? say("quoted", { name: thread }) : say("aConversation");
  const machine = t.computer ? nameIn(namer.names, "tags.computer", t.computer)?.name : undefined;
  const computer = machine ? say("quoted", { name: machine }) : say("aComputer");
  const q = item.quantities;
  const tokens = (q.input ?? 0) + (q.output ?? 0);
  const who = everyone && t.person ? namer.nameOf(t.person) : undefined;
  const space = t.space ? namer.spaceOf(t.space) : undefined;
  let icon: ReactNode;
  let title: ReactNode;
  let details: (string | undefined | null)[];
  switch (item.kind) {
    case "turn": {
      const hit = hitRate(q.cached ?? 0, q.input ?? 0);
      icon = <Avatar name={t.agent ?? "agent"} kind="agent" size={28} />;
      title = say("turnTitle", { agent: t.agent ? agentName(t.agent) : say("anAgent"), where });
      details = [
        item.subject ? namer.modelName(item.subject) : null,
        tokens ? say("tokens", { tokens: compact(tokens) }) : null,
        hit ? say("fromCache", { percent: percent(hit) }) : null,
      ];
      break;
    }
    case "model": {
      icon = (
        <span className="usage-face">
          <Icon name={t.agent ? "bot" : "note"} size={14} />
        </span>
      );
      // A conversation's upkeep; else an agent's calls outside a turn, or what they were for.
      title = t.agent
        ? say("turnTitle", { agent: agentName(t.agent), where })
        : t.thread
        ? say("upkeepOf", { where })
        : t.purpose
        ? purposeSaid(t.purpose)
        : say("modelCalls");
      details = [
        item.purposes?.length
          ? item.purposes.map((p, i) => i ? purposeSaid(p).toLowerCase() : purposeSaid(p)).join(
            ", ",
          )
          : null,
        say("calls", { count: item.uses, calls: item.uses }),
        tokens ? say("tokens", { tokens: compact(tokens) }) : null,
      ];
      break;
    }
    case "session":
    case "computer": {
      const subject = item.subject ?? "";
      const size = subject.startsWith("cloud/") ? subject.slice("cloud/".length) : subject;
      icon = (
        <span className="usage-face">
          <Icon name="computer" size={14} />
        </span>
      );
      if (size === "disk" || size === "snapshot") {
        title = say(size === "disk" ? "diskOf" : "snapshotOf", { computer });
        details = [
          say("gbHours", { amount: compact(q.gbHours ?? 0) }),
          say("onDay", { day: dayShort(item.first) }),
        ];
      } else {
        title = say.nodes("computerTitle", {
          computer,
          size: <span className="usage-quiet">({agentName(size)})</span>,
        });
        const woke = item.kind === "session" && t.session && !Number.isNaN(Date.parse(t.session))
          ? t.session
          : undefined;
        details = [
          durationSaid(q.seconds ?? 0),
          woke
            ? say("woke", { from: clock(woke), last: clock(item.last) })
            : say("onDay", { day: dayShort(item.first) }),
        ];
      }
      break;
    }
    case "app": {
      const app = t.app ? nameIn(namer.names, "tags.app", t.app)?.name : undefined;
      icon = (
        <span className="usage-face">
          <Icon name="globe" size={14} />
        </span>
      );
      title = say("appTitle", { app: app ? say("quoted", { name: app }) : say("anApp") });
      details = [
        q.requests ? say("requests", { requests: compact(q.requests) }) : null,
        q.minutes ? say("buildMinutes", { count: q.minutes, minutes: compact(q.minutes) }) : null,
        say("onDay", { day: dayShort(item.first) }),
      ];
      break;
    }
    default: {
      icon = (
        <span className="usage-face">
          <Icon name="tool" size={14} />
        </span>
      );
      title = say("meterTitle", {
        meter: agentName(item.meter ?? ""),
        model: modelOf(item.subject ?? "").name,
      });
      details = [
        say("uses", { count: item.uses }),
        say("onDay", { day: dayShort(item.first) }),
      ];
    }
  }
  const calls = item.kind === "turn" ? item.calls ?? [] : [];
  return (
    <li className="usage-item" data-open={open || undefined}>
      <div className="usage-item-main">
        <span className="usage-item-when">
          <Time at={item.last} />
        </span>
        {icon}
        <span className="usage-item-text">
          <span className="usage-item-title">{title}</span>
          <span className="usage-item-details">
            {[...details, who, space].filter(Boolean).join(" · ")}
          </span>
        </span>
        <Price
          price={item.price}
          paid={t.paid}
          unpriced={item.unpriced >= item.uses}
          cost={item.cost}
          staff={staff}
        />
        {calls.length
          ? (
            <IconButton
              icon={open ? "chevron-down" : "chevron"}
              label={open ? say("hideModelCalls") : say("showModelCalls", { count: calls.length })}
              size="sm"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            />
          )
          : <span className="usage-item-pad" />}
      </div>
      {open && calls.length ? <Calls calls={calls} staff={staff} namer={namer} /> : null}
    </li>
  );
}

/** A turn's model calls: when, which model, its tokens and cache, what each was charged. */
export function Calls(
  { calls, staff, namer }: { calls: ActivityCall[]; staff: boolean; namer: Sayers },
): ReactNode {
  return (
    <div className="usage-wide usage-calls-box">
      <table className="usage-table usage-calls">
        <thead>
          <tr>
            <th scope="col">{say("time")}</th>
            <th scope="col">{say("model")}</th>
            <th scope="col" className="usage-num">{say("inColumn")}</th>
            <th scope="col" className="usage-num">{say("fromCacheColumn")}</th>
            <th scope="col" className="usage-num">{say("outColumn")}</th>
            <th scope="col" className="usage-num">{say("spend")}</th>
            {staff
              ? (
                <th scope="col" className="usage-num usage-staff-col">
                  <span className="usage-staff-th">
                    <Icon name="shield" size={11} />
                    {say("costColumn")}
                  </span>
                </th>
              )
              : null}
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => {
            const read = c.quantities.cached ?? 0;
            const input = c.quantities.input ?? 0;
            return (
              <tr key={c._id}>
                <td className="usage-quiet">{clock(c.at, true)}</td>
                <td>
                  <span className="usage-model">
                    {namer.modelName(c.subject)}
                    {c.meter !== "llm" ? <span className="usage-quiet">{c.meter}</span> : null}
                  </span>
                </td>
                <td className="usage-num">{compact(input)}</td>
                <td className="usage-num">
                  {read
                    ? `${compact(read)} · ${percent(hitRate(read, input))}`
                    : <span className="usage-quiet">—</span>}
                </td>
                <td className="usage-num">{compact(c.quantities.output ?? 0)}</td>
                <td className="usage-num">
                  <Price
                    price={c.price ?? 0}
                    paid={c.paid}
                    unpriced={c.unpriced?.includes("price")}
                    staff={false}
                  />
                </td>
                {staff
                  ? (
                    <td className="usage-num usage-staff-col">
                      {c.cost === undefined
                        ? <span className="usage-quiet">—</span>
                        : usd(c.cost, true)}
                    </td>
                  )
                  : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
