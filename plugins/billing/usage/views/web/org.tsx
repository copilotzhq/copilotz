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
import { nameOf as personName } from "../../../../access/spaces/contract.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Org = { id: string; name: string; kind: string };
type Person = { person: string; name?: string; email?: string; picture?: string };
type Named = Record<string, Record<string, { name: string; owner?: string }>>;
type Filter = Record<string, unknown>;

/** What `billing.state` answers that this page reads (the credits plugin's; absent without it). */
type Billing = {
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

type Activity = { items: ActivityItem[]; more: boolean; names: Named };

const FIRST = 20;
const MORE = 30;

/** Kinds in the order their colours keep, whatever each spent. */
const KINDS = ["agents", "computers", "apps"];
const KIND: Record<string, { name: string; icon: IconName }> = {
  agents: { name: "Agents", icon: "bot" },
  computers: { name: "Computers", icon: "computer" },
  apps: { name: "Apps", icon: "globe" },
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
      ? "Not tied to anyone"
      : person === me
      ? "You"
      : people.get(person)?.name || people.get(person)?.email || personName(person);
  /** Whose face: their own name's, even when it says "You". */
  const faceOf = (person: string) => people.get(person)?.name || personName(person);
  const spaceOf = (space: string) => {
    if (!space) return "Space not recorded";
    const found = nameIn(names, "tags.space", space);
    if (!found) return "A space you don't reach";
    if (!found.owner) return found.name;
    return found.owner === me ? "Your Personal space" : `${faceOf(found.owner)}'s Personal space`;
  };
  const modelName = (subject: string) => models.get(subject) ?? modelOf(subject).name;
  const say: Sayers = { nameOf, faceOf, spaceOf, modelName, people, names };

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
        action={<Button size="sm" onClick={() => ask((n) => n + 1)}>Try again</Button>}
      >
        We couldn't read this org's usage just now. {error}
      </Notice>
    );
  }

  const choices = [...new Set([current, ...(months ?? []).map((t) => String(t.key.month))])]
    .filter((m) => m && m <= current).sort().reverse();
  const spentIn = new Map((months ?? []).map((t) => [String(t.key.month), t.price]));
  const filters = (
    <div className="usage-filters">
      <Select
        aria-label="Month"
        className="usage-period"
        value={month}
        onChange={(event) => setMonth(event.target.value)}
      >
        {choices.map((m) => (
          <option key={m} value={m}>
            {/* This month's spend is the headline's; past months say theirs (this year's, short). */}
            {m === current ? "This month" : monthSaid(m, m.slice(0, 4) === current.slice(0, 4))}
            {m !== current && spentIn.get(m) ? ` · ${usd(spentIn.get(m)!)}` : ""}
          </option>
        ))}
      </Select>
      {manage && !personal
        ? (
          <Select
            aria-label="Whose usage"
            className="usage-whose-pick"
            value={whose}
            onChange={(event) => setWhose(event.target.value as typeof whose)}
          >
            <option value="all">Everyone</option>
            <option value="mine">Just you</option>
          </Select>
        )
        : null}
      <span className="usage-filters-gap" />
      <IconButton
        icon="refresh"
        label="Read it again"
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
            Your own usage. The org's owners and admins see everyone's.
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
          <div className="usage-chips" aria-label="Kept to">
            <span className="usage-chips-label">Showing only</span>
            {chips.map((chip) => (
              <span key={`${chip.dimension}:${chip.key}`} className="usage-chip">
                <span className="usage-chip-what">{DIMENSIONS[chip.dimension].label}:</span>
                <span className="usage-chip-name">{chip.label}</span>
                <button
                  type="button"
                  className="usage-chip-x"
                  aria-label={`Show all, not only ${chip.label}`}
                  onClick={() => setChips(chips.filter((c) => c !== chip))}
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
            {chips.length > 1
              ? (
                <Button size="sm" variant="ghost" onClick={() => setChips([])}>
                  Show everything
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
            say={say}
          />
        )
        : (
          <Card className="usage-empty">
            <EmptyState
              icon="chart"
              title={ongoing
                ? "Nothing used this month yet"
                : `Nothing used in ${monthSaid(month)}`}
            >
              {everyone
                ? "As agents answer, computers run and apps serve in this org, what each was charged shows here, by kind, space, person, agent and model."
                : "As agents answer and computers run for you, what each was charged shows here."}
            </EmptyState>
          </Card>
        )}
      {activity && (activity.items.length || report.totals.length)
        ? (
          <ActivityCard
            activity={activity}
            everyone={everyone}
            staff={staff}
            say={say}
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
              We don't know what {spent.unpriced.toLocaleString()}{" "}
              {spent.unpriced === 1 ? "use" : "uses"}{" "}
              cost: their models aren't in the price catalog, and the app sets no rate for them, so
              the spend may leave them out.
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
type Sayers = {
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
function Headline(
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
  const when = ongoing ? "this month" : `in ${monthSaid(month)}`;
  const delta = change(spent.spend, before);
  const way = delta === undefined
    ? undefined
    : delta > 0.005
    ? "up"
    : delta < -0.005
    ? "down"
    : "flat";
  const against = ongoing ? "this point last month" : monthSaid(monthBefore(month));
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
        {binding.what === "budget" ? "the budget is used up" : "out of credits"}
      </span>
    )
    : (
      <span className="usage-left" data-tone={tone}>
        {usd(binding.left)} {binding.what === "credits" ? "of credits left" : "left"}
        {lasts
          ? binding.what === "budget" && binding.left / perDay >= monthLeft
            ? ", enough for the month at this pace"
            : `, ${lasts} at this pace`
          : null}
      </span>
    );
  return (
    <section className="usage-head" aria-label="This month">
      <p className="usage-headline">
        <b className="usage-amount">{usd(spent.spend)}</b>{" "}
        <span>
          spent {!everyone ? "by you " : ""}
          {when}
        </span>
        {filtered && whole > 0
          ? <span className="usage-dot">{percent(spent.spend / whole)} of all spend</span>
          : null}
        {limit !== undefined
          ? (
            <span className="usage-dot">
              {percent(share)} of the {usd(limit)} budget
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
            aria-label="Spent this month, against the budget"
            aria-valuemin={0}
            aria-valuemax={limit}
            aria-valuenow={Math.min(counted, limit)}
            aria-valuetext={`${usd(counted)} of ${usd(limit)}`}
          >
            <span style={{ width: `${Math.min(1, share ?? 0) * 100}%` }} />
            {ongoing
              ? (
                <i
                  className="usage-meter-now"
                  style={{ left: `${(elapsed / days) * 100}%` }}
                  title="How far into the month we are"
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
              {ARROWS[way]} {changeSaid(delta!)} <span>vs. {against}</span>
            </span>
          )
          : spent.spend > 0
          ? <span>Nothing {ongoing ? "by this point last month" : `in ${against}`}</span>
          : null}
        {spent.saved > 0
          ? <span className="usage-dot">caching saved {usd(spent.saved)}</span>
          : spent.saved < 0
          ? <span className="usage-dot">caching cost {usd(-spent.saved)} more than it saved</span>
          : null}
        {manage && billing
          ? (
            <a className="usage-billing" href="/org?tab=billing">
              Billing <span aria-hidden="true">→</span>
            </a>
          )
          : null}
      </p>
      {staff
        ? (
          <p className="usage-staff-line">
            <Badge tone="warning">
              <Icon name="shield" size={12} />
              Staff only
            </Badge>
            <span>
              Cost <b>{usd(spent.cost ?? 0)}</b>
            </span>
            <span className="usage-dot">
              <b>{percent(marginOf(spent.spend, spent.cost))}</b> margin
            </span>
            <span className="usage-dot">
              {usd(Math.abs(spent.spend - (spent.cost ?? 0)))}{" "}
              {spent.spend < (spent.cost ?? 0) ? "under" : "over"} cost
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
function Breakdown(
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
    say,
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
    say: Sayers;
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
      name: label(dimension, r, say),
      color: colorOf(i),
    })),
    ...(many ? [{ key: "*", name: "The rest", color: colorOf(SERIES) }] : []),
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
  const per = DIMENSIONS[dimension].label.toLowerCase();
  return (
    <Card as="section" className="usage-card usage-by" aria-labelledby="usage-by">
      <header className="usage-card-head usage-by-head">
        <h3 id="usage-by">Spend by</h3>
        <Tabs
          label="Spend by"
          value={dimension}
          onChange={setDimension}
          tabs={dims.map(([value, d]) => ({ value: value as Dimension, label: d.label }))}
        />
      </header>
      <StackedChart
        columns={columns}
        series={series}
        today={today}
        chosen={pick}
        label={`Spend per day in ${monthSaid(month)}, by ${per}`}
      />
      <ul className="usage-rows" aria-label={`By ${per}: choose one to see only it`}>
        {shown.map((row) => {
          const name = label(dimension, row, say);
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
                title={on ? "Show all again" : `See only ${name}`}
              >
                <i className="usage-swatch" style={{ background: colorOf(i) }} aria-hidden="true" />
                {face(dimension, row, say)}
                <span className="usage-row-text">
                  <span className="usage-row-name">
                    <span className="usage-row-label">{name}</span>
                    {detailOf(dimension, row, say)
                      ? <span className="usage-row-detail">{detailOf(dimension, row, say)}</span>
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
                        Cost {usd(row.cost)}
                        {marginOf(row.spend, row.cost) !== undefined
                          ? ` · ${percent(marginOf(row.spend, row.cost))} margin`
                          : ""}
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
            {all ? "Show fewer" : `Show all ${rows.length}`}
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
    `${compact(row.tokens)} tokens`,
    `${compact(row.uses)} ${row.uses === 1 ? "call" : "calls"}`,
    hit !== undefined ? `${percent(hit)} of input from cache` : null,
    row.saved > 0 ? `caching saved ${usd(row.saved)}` : null,
  ].filter(Boolean).join(" · ");
}

/** A kind by name: Agents, Computers, Apps, or an app's own meter. */
const kindName = (kind: string) => KIND[kind]?.name ?? agentName(kind);

/** A row's name in its dimension. */
function label(dimension: Dimension, row: Row, say: Sayers): string {
  const [what, ...rest] = row.key.split(":");
  const value = rest.join(":");
  switch (dimension) {
    case "kind":
      return kindName(row.key);
    case "space":
      return say.spaceOf(row.key);
    case "person":
      return say.nameOf(row.key);
    case "agent":
      return what === "agent"
        ? agentName(value)
        : what === "upkeep"
        ? "Conversation upkeep"
        : what === "purpose"
        ? purposeSaid(value)
        : what === "category"
        ? kindName(value)
        : "Other model use";
    case "model":
      return what === "subject" ? say.modelName(value) : kindName(value);
  }
}

/** What a row is, said beside its name, where its name doesn't say it all. */
function detailOf(dimension: Dimension, row: Row, _say: Sayers): string | undefined {
  const [what, ...rest] = row.key.split(":");
  if (dimension === "agent" && what === "upkeep") return "summaries, memory notes, voice";
  if (dimension === "model" && what === "subject") return modelOf(rest.join(":")).provider;
  if (dimension === "space" && !row.key) return "used before spaces were recorded";
  return undefined;
}

/** A row's face: a person's or agent's avatar, a space's, or its kind's icon. */
function face(dimension: Dimension, row: Row, say: Sayers): ReactNode {
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
      return row.key ? <Avatar name={say.spaceOf(row.key)} kind="space" size={26} /> : icon("info");
    case "person":
      return row.key
        ? (
          <Avatar
            name={say.faceOf(row.key)}
            picture={say.people.get(row.key)?.picture}
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
    ? { label: "Your key", title: "Ran on your own key: no credits used" }
    : tags?.paid === "subscription"
    ? { label: "Plan", title: "Ran on a connected plan: no credits used" }
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
        ? <span className="usage-quiet" title="No known cost">—</span>
        : usd(price, true)}
      {staff && cost !== undefined
        ? (
          <span className="usage-price-staff" title="Cost and margin: staff only">
            {usd(cost, true)} · {percent(marginOf(price, cost))}
          </span>
        )
        : null}
    </span>
  );
}

/** The time of a day, as the clock says it: "14:05". */
const clock = (at: string, seconds = false) =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });

/** A day, short: "Nov 2". */
const dayShort = (at: string) =>
  new Date(at.length === 10 ? `${at}T12:00:00Z` : at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

/** What was done, newest first, kept to the same chips. */
function ActivityCard(
  { activity, everyone, staff, say, more, filtered }: {
    activity: Activity;
    everyone: boolean;
    staff: boolean;
    say: Sayers;
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
        <h3 id="usage-activity">Activity</h3>
        <p>
          {staff ? <Badge tone="warning">Cost and margin: staff only</Badge> : null}
          {everyone ? "Everyone's" : "Yours"}, newest first{filtered ? ", as filtered" : ""}
        </p>
      </header>
      {activity.items.length
        ? (
          <ul className="usage-items">
            {activity.items.map((item) => (
              <Item key={item.id} item={item} everyone={everyone} staff={staff} say={say} />
            ))}
          </ul>
        )
        : <p className="usage-none">Nothing here matches what's chosen.</p>}
      {activity.more
        ? (
          <Button size="sm" variant="ghost" className="usage-more usage-more-items" onClick={more}>
            Show older
          </Button>
        )
        : null}
    </Card>
  );
}

/** A thing done: its time, what it was in words, its details, what it was charged. */
function Item(
  { item, everyone, staff, say }: {
    item: ActivityItem;
    everyone: boolean;
    staff: boolean;
    say: Sayers;
  },
): ReactNode {
  const [open, setOpen] = useState(false);
  const t = item.tags;
  const thread = t.thread ? nameIn(say.names, "tags.thread", t.thread)?.name : undefined;
  const where = thread ? `“${thread}”` : "a conversation";
  const machine = t.computer ? nameIn(say.names, "tags.computer", t.computer)?.name : undefined;
  const computer = machine ? `“${machine}”` : "a computer";
  const q = item.quantities;
  const tokens = (q.input ?? 0) + (q.output ?? 0);
  const who = everyone && t.person ? say.nameOf(t.person) : undefined;
  const space = t.space ? say.spaceOf(t.space) : undefined;
  let icon: ReactNode;
  let title: ReactNode;
  let details: (string | undefined | null)[];
  switch (item.kind) {
    case "turn": {
      const hit = hitRate(q.cached ?? 0, q.input ?? 0);
      icon = <Avatar name={t.agent ?? "agent"} kind="agent" size={28} />;
      title = <>{agentName(t.agent ?? "An agent")} in {where}</>;
      details = [
        item.subject ? say.modelName(item.subject) : null,
        tokens ? `${compact(tokens)} tokens` : null,
        hit ? `${percent(hit)} from cache` : null,
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
        ? <>{agentName(t.agent)} in {where}</>
        : t.thread
        ? <>Upkeep of {where}</>
        : t.purpose
        ? purposeSaid(t.purpose)
        : "Model calls";
      details = [
        item.purposes?.length
          ? item.purposes.map((p, i) => i ? purposeSaid(p).toLowerCase() : purposeSaid(p)).join(
            ", ",
          )
          : null,
        `${item.uses} ${item.uses === 1 ? "call" : "calls"}`,
        tokens ? `${compact(tokens)} tokens` : null,
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
        title = <>{size === "disk" ? "Disk" : "Snapshot"} of {computer}</>;
        details = [`${compact(q.gbHours ?? 0)} GB-hours`, `on ${dayShort(item.first)}`];
      } else {
        title = (
          <>
            Computer {computer} <span className="usage-quiet">({agentName(size)})</span>
          </>
        );
        const woke = item.kind === "session" && t.session && !Number.isNaN(Date.parse(t.session))
          ? t.session
          : undefined;
        details = [
          durationSaid(q.seconds ?? 0),
          woke ? `woke ${clock(woke)}, last ${clock(item.last)}` : `on ${dayShort(item.first)}`,
        ];
      }
      break;
    }
    case "app": {
      const app = t.app ? nameIn(say.names, "tags.app", t.app)?.name : undefined;
      icon = (
        <span className="usage-face">
          <Icon name="globe" size={14} />
        </span>
      );
      title = <>App {app ? `“${app}”` : "an app"}</>;
      details = [
        q.requests ? `${compact(q.requests)} requests` : null,
        q.minutes ? `${compact(q.minutes)} build ${q.minutes === 1 ? "minute" : "minutes"}` : null,
        `on ${dayShort(item.first)}`,
      ];
      break;
    }
    default: {
      icon = (
        <span className="usage-face">
          <Icon name="tool" size={14} />
        </span>
      );
      title = <>{agentName(item.meter ?? "")}: {modelOf(item.subject ?? "").name}</>;
      details = [`${item.uses} ${item.uses === 1 ? "use" : "uses"}`, `on ${dayShort(item.first)}`];
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
              label={open
                ? "Hide its model calls"
                : `Show its ${calls.length} model ${calls.length === 1 ? "call" : "calls"}`}
              size="sm"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            />
          )
          : <span className="usage-item-pad" />}
      </div>
      {open && calls.length ? <Calls calls={calls} staff={staff} say={say} /> : null}
    </li>
  );
}

/** A turn's model calls: when, which model, its tokens and cache, what each was charged. */
function Calls(
  { calls, staff, say }: { calls: ActivityCall[]; staff: boolean; say: Sayers },
): ReactNode {
  return (
    <div className="usage-wide usage-calls-box">
      <table className="usage-table usage-calls">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Model</th>
            <th scope="col" className="usage-num">In</th>
            <th scope="col" className="usage-num">From cache</th>
            <th scope="col" className="usage-num">Out</th>
            <th scope="col" className="usage-num">Spend</th>
            {staff
              ? (
                <th scope="col" className="usage-num usage-staff-col">
                  <span className="usage-staff-th">
                    <Icon name="shield" size={11} />
                    Cost
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
                    {say.modelName(c.subject)}
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
