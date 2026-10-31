/**
 * The org's usage (kind `usage.org`, a section of the org's page, the web
 * shell's `orgSettings`), where the app serves many orgs: for a period (7,
 * 30 or 90 days), what was used and what it was charged (its spend),
 * against the period before (spend, tokens, calls, how much input came from
 * a cache); day by day, as a chart whose numbers are a table too; by
 * person, agent and model, largest first with their share; caching, in all
 * and by model (what was read from a cache and written to one, what each
 * was charged, what caching saved); and the latest calls. Its owners and
 * admins see everyone's (`usage.org`, `usage.calls`), or just theirs;
 * anyone else, their own.
 *
 * Every amount is a price: what people are charged. Platform staff alone
 * see what it cost too, and so the margin (the answers say so: `costs`), in
 * the staff colour and marked as theirs.
 */
import { type ReactNode, useEffect, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  IconButton,
  message,
  Notice,
  Select,
  Skeleton,
  Tabs,
  Time,
  Tooltip,
} from "../../../../../hosts/web/mod.ts";
import { runs, type Standing } from "../../../../interfaces/web/contract.ts";
import { DailyChart } from "./chart.tsx";
import {
  agentName,
  cacheByModel,
  change,
  changeSaid,
  compact,
  daysOf,
  type Group,
  groupsOf,
  hitRate,
  inputParts,
  marginOf,
  type Measure,
  modelOf,
  percent,
  periodOf,
  pointsSaid,
  said,
  savedSaid,
  type Sum,
  sums,
  type Total,
  usd,
} from "./numbers.ts";
import { STYLE } from "./style.ts";
import { nameOf as personName } from "../../../../access/spaces/contract.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Org = { id: string; name: string; kind: string };
type Person = { person: string; name?: string; email?: string; picture?: string };

/** A use, as `usage.calls` answers: at its price; its cost too, for staff. */
type Use = {
  _id: string;
  meter: string;
  subject: string;
  quantities: Record<string, number>;
  tags?: Record<string, string>;
  price?: number;
  prices?: Record<string, number>;
  saved?: { price?: number; cost?: number };
  cost?: number;
  costs?: Record<string, number>;
  unpriced?: string[];
  at: string;
};

type Report = {
  byDay: Total[];
  people: Total[];
  agents: Total[];
  models: Total[];
  calls: Use[];
  /** Everyone's (they run the org), or their own. */
  all: boolean;
  /** What it cost, and so the margin: for platform staff alone. */
  costs: boolean;
};

const PERIODS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

const MEASURES: { value: Measure; label: string; per: string }[] = [
  { value: "spend", label: "Spend", per: "Spend per day" },
  { value: "tokens", label: "Tokens", per: "Tokens per day" },
  { value: "calls", label: "Calls", per: "Calls per day" },
];

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

function Usage(
  { org, standing, me, call }: { org?: Org; standing: Standing; me?: string; call: Call },
): ReactNode {
  const manage = runs(standing);
  const personal = org?.kind === "personal";
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [whose, setWhose] = useState<"all" | "mine">("all");
  // What the chart and the groups measure: spend, unless nothing's priced, until they choose.
  const [chosen, setMeasure] = useState<Measure>();
  const [report, setReport] = useState<Report>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [people, setPeople] = useState<Map<string, Person>>(new Map());
  const [asked, ask] = useState(0);
  const span = Number(days);
  const { since, before } = periodOf(span);
  const mine = (whose === "mine" || !manage) && me ? { "tags.person": me } : {};

  useEffect(() => {
    let current = true;
    setLoading(true);
    const totals = (filter: Record<string, unknown>, by: string[]) =>
      call<{ totals: Total[]; all: boolean; costs?: boolean }>("usage.org", {
        filter: { ...filter, ...mine },
        by,
      });
    Promise.all([
      totals({ at: { $gte: before } }, ["day"]),
      totals({ at: { $gte: since } }, ["tags.person"]),
      totals({ at: { $gte: since } }, ["tags.agent"]),
      totals({ at: { $gte: since } }, ["subject"]),
      call<{ calls: Use[]; all: boolean }>("usage.calls", { limit: 12, filter: mine }),
    ]).then(
      ([byDay, people, agents, models, calls]) => {
        if (!current) return;
        setReport({
          byDay: byDay.totals,
          people: people.totals,
          agents: agents.totals,
          models: models.totals,
          calls: calls.calls,
          all: byDay.all && whose === "all",
          costs: byDay.costs === true,
        });
        setError(undefined);
        setLoading(false);
      },
      (e) => {
        if (!current) return;
        setError(message(e));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [days, whose, asked]);

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

  const priced = report ? sums(report.byDay, since).now.spend > 0 : true;
  const measure: Measure = chosen ?? (priced ? "spend" : "tokens");
  if (error && !report) {
    return (
      <Notice
        tone="destructive"
        role="alert"
        action={<Button size="sm" onClick={() => ask((n) => n + 1)}>Try again</Button>}
      >
        {error}
      </Notice>
    );
  }
  const everyone = !!report?.all;
  const filters = (
    <div className="usage-filters">
      <Select
        aria-label="Period"
        className="usage-period"
        value={days}
        onChange={(event) => setDays(event.target.value as typeof days)}
      >
        {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
      </Select>
      {manage && !personal
        ? (
          <Tabs
            label="Whose usage"
            value={whose}
            onChange={setWhose}
            tabs={[{ value: "all", label: "Everyone" }, { value: "mine", label: "Just you" }]}
          />
        )
        : null}
      <span className="usage-filters-gap" />
      <span className="usage-filters-end">
        <Tabs label="Measure" value={measure} onChange={setMeasure} tabs={MEASURES} />
        <IconButton
          icon="refresh"
          label="Read it again"
          loading={loading && !!report}
          onClick={() => ask((n) => n + 1)}
        />
      </span>
    </div>
  );
  if (!report) {
    return (
      <div className="usage" aria-busy="true">
        {filters}
        <div className="usage-tiles">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={104} radius="lg" />)}
        </div>
        <Skeleton height={280} radius="xl" />
      </div>
    );
  }
  const staff = report.costs;
  const { now, before: then } = sums(report.byDay, since);
  const series = daysOf(report.byDay.filter((t) => String(t.key.day) >= since.slice(0, 10)), span);
  const active = report.people.filter((t) => t.key["tags.person"]).length;
  const agents = report.agents.filter((t) => t.key["tags.agent"]).length;
  const hit = hitRate(now.cached, now.input);
  const hitBefore = hitRate(then.cached, then.input);
  const of = people.size >= active ? people.size : 0;
  const callsNote = everyone
    ? active
      ? `by ${active}${of ? ` of ${of}` : ""} ${(of || active) === 1 ? "person" : "people"}`
      : null
    : agents
    ? `through ${agents} ${agents === 1 ? "agent" : "agents"}`
    : null;
  const per = MEASURES.find((m) => m.value === measure)!;
  const period = `the last ${span} days`;
  // Never a sign-in's id: someone no longer in the org is "someone".
  const nameOf = (person: string) =>
    person === me ? "You" : people.get(person)?.name || people.get(person)?.email ||
      (person ? personName(person) : "The app itself");
  /** Whose face: their own name's, even when it says "You". */
  const faceOf = (person: string) => people.get(person)?.name || personName(person);
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
      {now.calls
        ? (
          <>
            <div className="usage-tiles">
              <Tile
                label="Spend"
                value={usd(now.spend)}
                trend={trendOf(change(now.spend, then.spend), changeSaid)}
                span={span}
                notes={[now.unpriced ? `${callCount(now.unpriced)} with no known cost` : null]}
              />
              <Tile
                label="Tokens"
                value={compact(now.tokens)}
                trend={trendOf(change(now.tokens, then.tokens), changeSaid)}
                span={span}
                notes={[
                  now.tokens ? `${compact(now.input)} in · ${compact(now.output)} out` : null,
                ]}
              />
              <Tile
                label="Calls"
                value={compact(now.calls)}
                trend={trendOf(change(now.calls, then.calls), changeSaid)}
                span={span}
                notes={[callsNote]}
              />
              <Tile
                label="Input from cache"
                value={percent(hit)}
                trend={hit !== undefined && hitBefore !== undefined
                  ? trendOf(hit - hitBefore, pointsSaid)
                  : undefined}
                span={hit !== undefined ? span : undefined}
                notes={[hit === undefined ? "No model input yet" : savedSaid(now.saved)]}
              />
            </div>
            {staff ? <Staff now={now} then={then} span={span} /> : null}
            <Card as="section" className="usage-card usage-days" aria-labelledby="usage-days">
              <header className="usage-card-head">
                <h3 id="usage-days">{per.per}</h3>
                <p>
                  <b>{said(now[measure], measure)}</b> in {period}
                </p>
              </header>
              <DailyChart days={series} measure={measure} label={`${per.per}, ${period}`} />
            </Card>
            <div className="usage-groups">
              {everyone
                ? (
                  <Breakdown
                    title="By person"
                    groups={groupsOf(report.people, "tags.person", measure)}
                    measure={measure}
                    staff={staff}
                    name={(key) => nameOf(key)}
                    face={(key) =>
                      key
                        ? <Avatar name={faceOf(key)} picture={people.get(key)?.picture} size={26} />
                        : (
                          <span className="usage-face-none">
                            <Icon name="settings" size={13} />
                          </span>
                        )}
                  />
                )
                : null}
              <Breakdown
                title="By agent"
                groups={groupsOf(report.agents, "tags.agent", measure)}
                measure={measure}
                staff={staff}
                name={(key) => key ? agentName(key) : "No agent"}
                face={(key) =>
                  key
                    ? <Avatar name={key} kind="agent" size={26} />
                    : (
                      <span className="usage-face-none">
                        <Icon name="tool" size={13} />
                      </span>
                    )}
                hint="No agent: what the app did on its own, such as summaries and memories."
              />
              <Breakdown
                title="By model"
                groups={groupsOf(report.models, "subject", measure)}
                measure={measure}
                staff={staff}
                name={(key) => modelOf(key).name}
                detail={(key) => modelOf(key).provider}
                face={() => (
                  <span className="usage-face-model">
                    <Icon name="sparkles" size={13} />
                  </span>
                )}
              />
            </div>
            {now.input ? <Caching sum={now} models={report.models} period={period} /> : null}
            <Recent
              calls={report.calls}
              everyone={everyone}
              staff={staff}
              nameOf={nameOf}
              faceOf={faceOf}
              people={people}
            />
            {now.unpriced
              ? (
                <p className="usage-unpriced">
                  <Icon name="info" size={14} />
                  <span>
                    We don't know what {callCount(now.unpriced)}{" "}
                    cost: their models aren't in the price catalog, and the app sets no rate for
                    them, so the spend may leave them out. Their tokens and calls are counted all
                    the same.
                  </span>
                </p>
              )
              : null}
          </>
        )
        : (
          <Card className="usage-empty">
            <EmptyState icon="chart" title={`Nothing used in ${period}`}>
              {everyone
                ? "As agents answer in this org, what each call used and what it was charged shows here, by person, agent and model."
                : "As agents answer for you, what each call used and what it was charged shows here."}
            </EmptyState>
          </Card>
        )}
    </div>
  );
}

/** "1 call", "12 calls". */
const callCount = (n: number) => `${n.toLocaleString()} ${n === 1 ? "call" : "calls"}`;

/** Which way a change went, and how much, in words. */
type Trend = { way: "up" | "down" | "flat"; text: string };

const trendOf = (delta: number | undefined, say: (delta: number) => string): Trend | undefined =>
  delta === undefined ? undefined : {
    way: delta > 0.005 ? "up" : delta < -0.005 ? "down" : "flat",
    text: say(delta),
  };

const ARROWS = { up: "↑", down: "↓", flat: "→" };

/**
 * A headline number: its label, the value, how it changed from the period
 * before (`span` days; nothing then, it says so), and a note or two.
 */
function Tile(
  { label, value, trend, span, notes = [], staff }: {
    label: string;
    value: string;
    trend?: Trend;
    span?: number;
    notes?: (ReactNode | null)[];
    staff?: boolean;
  },
): ReactNode {
  return (
    <div className={staff ? "usage-tile usage-tile-staff" : "usage-tile"}>
      <span className="usage-tile-label">{label}</span>
      <span className="usage-tile-value">{value}</span>
      <span className="usage-tile-note">
        {span
          ? trend
            ? (
              <span className="usage-delta" data-way={trend.way}>
                {ARROWS[trend.way]} {trend.text}
                <span className="usage-delta-against">vs the {span} days before</span>
              </span>
            )
            : <span className="usage-delta-against">Nothing the {span} days before</span>
          : null}
        {notes.filter(Boolean).map((note, i) => (
          <span key={i} className="usage-tile-more">{note}</span>
        ))}
      </span>
    </div>
  );
}

/** What it cost and the margin, for platform staff alone: marked in their colour. */
function Staff({ now, then, span }: { now: Sum; then: Sum; span: number }): ReactNode {
  const cost = now.cost ?? 0;
  const over = now.spend - cost;
  return (
    <section className="usage-staff" aria-labelledby="usage-staff">
      <header className="usage-staff-head">
        <Badge tone="warning">
          <Icon name="shield" size={12} />
          Staff only
        </Badge>
        <span id="usage-staff">
          What it cost and the margin. The org's people only see what they're charged.
        </span>
      </header>
      <div className="usage-staff-tiles">
        <Tile
          staff
          label="Cost"
          value={usd(cost)}
          trend={trendOf(change(cost, then.cost ?? 0), changeSaid)}
          span={span}
        />
        <Tile
          staff
          label="Gross margin"
          value={percent(marginOf(now.spend, now.cost))}
          notes={[`${usd(Math.abs(over))} ${over < 0 ? "under" : "over"} cost`]}
        />
        <Tile
          staff
          label="Caching saved, at cost"
          value={usd(now.savedCost ?? 0)}
          notes={[`${usd(now.saved)} at the price`]}
        />
      </div>
    </section>
  );
}

/** Shown at first, of a long list: the rest a press away. */
const FIRST = 6;

/** Groups largest first: each one's name, its measure, its share as a bar, its other measures. */
function Breakdown(
  { title, groups, measure, staff, name, detail, face, hint }: {
    title: string;
    groups: Group[];
    measure: Measure;
    staff: boolean;
    name(key: string): string;
    detail?(key: string): string | undefined;
    face(key: string): ReactNode;
    hint?: string;
  },
): ReactNode {
  const [all, setAll] = useState(false);
  const shown = all ? groups : groups.slice(0, FIRST);
  const id = title.toLowerCase().replace(/\W+/g, "-");
  return (
    <Card as="section" className="usage-card usage-group" aria-labelledby={`usage-${id}`}>
      <header className="usage-card-head">
        <h3 id={`usage-${id}`}>{title}</h3>
        <p>{groups.length}</p>
      </header>
      <ul className="usage-rows">
        {shown.map((g) => (
          <li key={g.key} className="usage-row" title={!g.key ? hint : undefined}>
            {face(g.key)}
            <span className="usage-row-text">
              <span className="usage-row-name">
                {name(g.key)}
                {detail?.(g.key) ? <span className="usage-row-detail">{detail(g.key)}</span> : null}
              </span>
              <span className="usage-row-meter" aria-hidden="true">
                <span style={{ width: `${Math.max(g.share * 100, g.share ? 1.5 : 0)}%` }} />
              </span>
              <span className="usage-row-rest">
                {[
                  measure !== "spend" ? usd(g.spend) : null,
                  measure !== "tokens" ? `${compact(g.tokens)} tokens` : null,
                  measure !== "calls" ? callCount(g.calls) : null,
                ].filter(Boolean).join(" · ")}
              </span>
              {staff && g.cost !== undefined
                ? (
                  <span className="usage-row-staff">
                    <Icon name="shield" size={11} />
                    Cost {usd(g.cost)}
                    {marginOf(g.spend, g.cost) !== undefined
                      ? ` · ${percent(marginOf(g.spend, g.cost))} margin`
                      : ""}
                  </span>
                )
                : null}
            </span>
            <span className="usage-row-value">
              {said(g[measure], measure)}
              <span className="usage-row-share">{Math.round(g.share * 100)}%</span>
            </span>
          </li>
        ))}
      </ul>
      {groups.length > FIRST
        ? (
          <Button size="sm" variant="ghost" className="usage-more" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${groups.length}`}
          </Button>
        )
        : null}
    </Card>
  );
}

/**
 * Caching: how much of the input was read from a cache (charged much less),
 * written to one (charged a little more, once) or neither; what each was
 * charged and what caching saved; then the same by model.
 */
function Caching(
  { sum, models, period }: { sum: Sum; models: Total[]; period: string },
): ReactNode {
  const [all, setAll] = useState(false);
  const parts = inputParts(sum);
  const hit = hitRate(sum.cached, sum.input);
  const rows = cacheByModel(models);
  const shown = all ? rows : rows.slice(0, FIRST);
  const none = !sum.cached && !sum.cacheWrite;
  const split = [
    {
      kind: "cached",
      name: "Read from cache",
      tokens: parts.cached,
      share: parts.shares.cached,
      spend: sum.cachedSpend,
    },
    {
      kind: "written",
      name: "Written to cache",
      tokens: parts.written,
      share: parts.shares.written,
      spend: sum.cacheWriteSpend,
    },
    {
      kind: "fresh",
      name: "Not cached",
      tokens: parts.fresh,
      share: parts.shares.fresh,
      spend: sum.inputSpend,
    },
  ];
  return (
    <Card as="section" className="usage-card usage-cache" aria-labelledby="usage-cache">
      <header className="usage-card-head">
        <h3 id="usage-cache">Caching</h3>
        <p>
          <b>{percent(hit)}</b> of input from cache
        </p>
      </header>
      <p className="usage-lede">
        As a conversation goes on, a model can read what it has already seen from a cache instead of
        reading it all again: that input is charged much less. Writing to the cache is charged a
        little more, once.
      </p>
      {none
        ? (
          <p className="usage-cache-none">
            <Icon name="info" size={14} />
            <span>
              None of the {compact(sum.input)} input tokens in {period}{" "}
              came from a cache. Some models cache on their own as a conversation goes on; others
              only when the app asks them to.
            </span>
          </p>
        )
        : (
          <>
            <div className="usage-stats">
              <div className="usage-stat">
                <span className="usage-stat-label">Hit rate</span>
                <span className="usage-stat-value">{percent(hit)}</span>
                <span className="usage-stat-note">
                  {compact(sum.cached)} of {compact(sum.input)} input tokens
                </span>
              </div>
              <div className="usage-stat">
                <span className="usage-stat-label">Spent on caching</span>
                <span className="usage-stat-value">
                  {usd(sum.cachedSpend + sum.cacheWriteSpend)}
                </span>
                <span className="usage-stat-note">
                  {/* A model without a price for cached input charges it as input: say so, not $0. */}
                  {sum.cached > 0 && !sum.cachedSpend
                    ? "reading charged as input"
                    : `${usd(sum.cachedSpend)} reading`} ·{" "}
                  {sum.cacheWrite > 0 && !sum.cacheWriteSpend
                    ? "writing charged as input"
                    : `${usd(sum.cacheWriteSpend)} writing`}
                </span>
              </div>
              <div className="usage-stat">
                <span className="usage-stat-label">Saved by caching</span>
                <span className="usage-stat-value">{usd(sum.saved)}</span>
                <span className="usage-stat-note">
                  {sum.saved < 0
                    ? "Writing to the cache was charged more than reading from it saved"
                    : "Against the same input with no cache"}
                </span>
              </div>
            </div>
            <div className="usage-split">
              <div
                className="usage-split-bar"
                role="img"
                aria-label={`Input tokens: ${
                  split.map((s) => `${percent(s.share)} ${s.name.toLowerCase()}`).join(", ")
                }`}
              >
                {split.filter((s) => s.tokens > 0).map((s) => (
                  <span
                    key={s.kind}
                    className={`usage-c-${s.kind}`}
                    style={{ flexGrow: s.share }}
                  />
                ))}
              </div>
              <ul className="usage-split-legend">
                {split.map((s) => (
                  <li key={s.kind}>
                    <i className={`usage-key usage-c-${s.kind}`} />
                    <span className="usage-legend-name">
                      {s.name} <span className="usage-quiet">{percent(s.share)}</span>
                    </span>
                    <span className="usage-legend-num">
                      {compact(s.tokens)} tokens · {usd(s.spend)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {rows.length
              ? (
                <div className="usage-wide usage-cache-models">
                  <table className="usage-table">
                    <caption className="usage-sr">Caching by model</caption>
                    <thead>
                      <tr>
                        <th scope="col">Model</th>
                        <th scope="col">Hit rate</th>
                        <th scope="col" className="usage-num">Read from cache</th>
                        <th scope="col" className="usage-num">Written to cache</th>
                        <th scope="col" className="usage-num">Saved</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((g) => {
                        const model = modelOf(g.key);
                        const rate = hitRate(g.cached, g.input);
                        return (
                          <tr key={g.key}>
                            <th scope="row">
                              <span className="usage-model">
                                {model.name}
                                {model.provider
                                  ? <span className="usage-quiet">{model.provider}</span>
                                  : null}
                              </span>
                            </th>
                            <td>
                              <span className="usage-hit">
                                <span className="usage-meter" aria-hidden="true">
                                  <span style={{ width: `${(rate ?? 0) * 100}%` }} />
                                </span>
                                {percent(rate)}
                              </span>
                            </td>
                            <td className="usage-num">
                              <TokensAndSpend tokens={g.cached} spend={g.cachedSpend} />
                            </td>
                            <td className="usage-num">
                              <TokensAndSpend tokens={g.cacheWrite} spend={g.cacheWriteSpend} />
                            </td>
                            <td className="usage-num">
                              {g.cached || g.cacheWrite
                                ? usd(g.saved)
                                : <span className="usage-quiet">—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {rows.length > FIRST
                    ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="usage-more usage-more-wide"
                        onClick={() => setAll(!all)}
                      >
                        {all ? "Show fewer" : `Show all ${rows.length} models`}
                      </Button>
                    )
                    : null}
                </div>
              )
              : null}
          </>
        )}
    </Card>
  );
}

/** Tokens, with what they were charged under them; a dash for none. */
const TokensAndSpend = ({ tokens, spend }: { tokens: number; spend: number }): ReactNode =>
  tokens
    ? (
      <span className="usage-two">
        {compact(tokens)}
        <small>{usd(spend)}</small>
      </span>
    )
    : <span className="usage-quiet">—</span>;

/** The latest calls: when, whose, which agent, which model, what they used and were charged. */
function Recent(
  { calls, everyone, staff, nameOf, faceOf, people }: {
    calls: Use[];
    everyone: boolean;
    staff: boolean;
    nameOf(person: string): string;
    faceOf(person: string): string;
    people: Map<string, Person>;
  },
): ReactNode {
  if (!calls.length) return null;
  const staffHead = (label: string) => (
    <th scope="col" className="usage-num usage-staff-col">
      <span className="usage-staff-th">
        <Icon name="shield" size={11} />
        {label}
      </span>
    </th>
  );
  return (
    <Card
      as="section"
      padding="none"
      className="usage-card usage-recent"
      aria-labelledby="usage-recent"
    >
      <header className="usage-card-head usage-recent-head">
        <h3 id="usage-recent">Latest calls</h3>
        <p className="usage-recent-whose">
          {staff ? <Badge tone="warning">Cost and margin: staff only</Badge> : null}
          {everyone ? "Everyone's" : "Yours"}
        </p>
      </header>
      <div className="usage-wide">
        <table className="usage-table usage-calls">
          <thead>
            <tr>
              <th scope="col">When</th>
              {everyone ? <th scope="col">Who</th> : null}
              <th scope="col">Agent</th>
              <th scope="col">Model</th>
              <th scope="col" className="usage-num">In</th>
              <th scope="col" className="usage-num">
                <Tooltip text="Input tokens read from the model's cache, charged less. +N: written to it.">
                  <span className="usage-th-hint">Cached</span>
                </Tooltip>
              </th>
              <th scope="col" className="usage-num">Out</th>
              <th scope="col" className="usage-num">Spend</th>
              {staff ? staffHead("Cost") : null}
              {staff ? staffHead("Margin") : null}
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => {
              const person = c.tags?.person ?? "";
              const model = modelOf(c.subject);
              const read = c.quantities.cached ?? 0;
              const wrote = c.quantities.cacheWrite ?? 0;
              const price = c.unpriced?.includes("price") ? undefined : c.price;
              return (
                <tr key={c._id}>
                  <td className="usage-when">
                    <Time at={c.at} />
                  </td>
                  {everyone
                    ? (
                      <td>
                        <span className="usage-who">
                          <Avatar
                            name={faceOf(person)}
                            picture={people.get(person)?.picture}
                            size={20}
                          />
                          <span>{nameOf(person)}</span>
                        </span>
                      </td>
                    )
                    : null}
                  <td>
                    {c.tags?.agent
                      ? agentName(c.tags.agent)
                      : <span className="usage-quiet">—</span>}
                  </td>
                  <td>
                    <span className="usage-model">
                      {model.name}
                      {c.meter !== "llm" ? <span className="usage-quiet">{c.meter}</span> : null}
                    </span>
                  </td>
                  <td className="usage-num">{compact(c.quantities.input ?? 0)}</td>
                  <td className="usage-num">
                    {read || wrote
                      ? (
                        <Tooltip
                          text={`${read.toLocaleString()} read from the cache${
                            wrote ? ` · ${wrote.toLocaleString()} written to it` : ""
                          }`}
                        >
                          <span className="usage-cached-cell">
                            {compact(read)}
                            {wrote
                              ? (
                                <span className="usage-wrote">
                                  +{compact(wrote)}
                                  <span className="usage-sr">written</span>
                                </span>
                              )
                              : null}
                          </span>
                        </Tooltip>
                      )
                      : <span className="usage-quiet">—</span>}
                  </td>
                  <td className="usage-num">{compact(c.quantities.output ?? 0)}</td>
                  <td className="usage-num">
                    {price === undefined
                      ? <span className="usage-quiet" title="No known cost for this model">—</span>
                      : usd(price, true)}
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
                  {staff
                    ? (
                      <td className="usage-num usage-staff-col">
                        {percent(marginOf(price ?? 0, c.cost))}
                      </td>
                    )
                    : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
