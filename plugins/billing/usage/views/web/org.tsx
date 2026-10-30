/**
 * The org's usage (kind `usage.org`, a section of the org's page, the web
 * shell's `orgSettings`), where the app serves many orgs: for a period (7,
 * 30 or 90 days), what was used and what it cost, against the period before
 * (cost, tokens, calls, who used it); day by day, as a chart whose numbers
 * are a table too; by person, agent and model, largest first with their
 * share; and the latest calls. Its owners and admins see everyone's
 * (`usage.org`, `usage.calls`), or just theirs; anyone else, their own.
 */
import { type ReactNode, useEffect, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Avatar,
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
} from "../../../../../hosts/web/mod.ts";
import { runs, type Standing } from "../../../../interfaces/web/contract.ts";
import type { Totals } from "../../shared/totals.ts";
import { DailyChart } from "./chart.tsx";
import {
  agentName,
  change,
  compact,
  daysOf,
  type Group,
  groupsOf,
  type Measure,
  modelOf,
  periodOf,
  said,
  sums,
  usd,
} from "./numbers.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Org = { id: string; name: string; kind: string };
type Person = { person: string; name?: string; email?: string; picture?: string };

/** A use, as `usage.calls` answers. */
type Use = {
  _id: string;
  meter: string;
  subject: string;
  quantities: Record<string, number>;
  tags?: Record<string, string>;
  cost?: number;
  unpriced?: string[];
  at: string;
};

type Report = {
  byDay: Totals[];
  people: Totals[];
  agents: Totals[];
  models: Totals[];
  calls: Use[];
  /** Everyone's (they run the org), or their own. */
  all: boolean;
};

const PERIODS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

const MEASURES: { value: Measure; label: string; per: string }[] = [
  { value: "cost", label: "Cost", per: "Cost per day" },
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
  // What the chart and the groups measure: cost, unless nothing's priced, until they choose.
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
      call<{ totals: Totals[]; all: boolean }>("usage.org", { filter: { ...filter, ...mine }, by });
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

  const priced = report ? sums(report.byDay, since).now.cost > 0 : true;
  const measure: Measure = chosen ?? (priced ? "cost" : "tokens");
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
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={92} radius="lg" />)}
        </div>
        <Skeleton height={280} radius="xl" />
      </div>
    );
  }
  const { now, before: then } = sums(report.byDay, since);
  const series = daysOf(report.byDay.filter((t) => String(t.key.day) >= since.slice(0, 10)), span);
  const active = report.people.filter((t) => t.key["tags.person"]).length;
  const io = report.models.reduce(
    (n, t) => ({
      input: n.input + (t.quantities.input ?? 0),
      output: n.output + (t.quantities.output ?? 0),
    }),
    { input: 0, output: 0 },
  );
  const per = MEASURES.find((m) => m.value === measure)!;
  const period = `the last ${span} days`;
  const nameOf = (person: string) =>
    person === me
      ? "You"
      : people.get(person)?.name || people.get(person)?.email || person || "The app itself";
  /** Whose face: their own name's, even when it says "You". */
  const faceOf = (person: string) => people.get(person)?.name || person;
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
          <div className="usage-tiles">
            <Tile
              label="Cost"
              value={usd(now.cost)}
              delta={change(now.cost, then.cost)}
              span={span}
              note={now.unpriced ? `${now.unpriced.toLocaleString()} calls unpriced` : undefined}
            />
            <Tile
              label="Tokens"
              value={compact(now.tokens)}
              delta={change(now.tokens, then.tokens)}
              span={span}
              note={now.tokens ? `${compact(io.input)} in · ${compact(io.output)} out` : undefined}
            />
            <Tile
              label="Calls"
              value={compact(now.calls)}
              delta={change(now.calls, then.calls)}
              span={span}
            />
            {everyone
              ? (
                <Tile
                  label="People using it"
                  value={String(active)}
                  note={people.size >= active
                    ? `of ${people.size} in ${org?.name ?? "the org"}`
                    : "including some who have left"}
                />
              )
              : (
                <Tile
                  label="Agents"
                  value={String(report.agents.filter((t) => t.key["tags.agent"]).length)}
                  note="that worked for you"
                />
              )}
          </div>
        )
        : null}
      {now.calls
        ? (
          <>
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
                name={(key) => modelOf(key).name}
                detail={(key) => modelOf(key).provider}
                face={() => (
                  <span className="usage-face-model">
                    <Icon name="sparkles" size={13} />
                  </span>
                )}
              />
            </div>
            <Recent
              calls={report.calls}
              everyone={everyone}
              nameOf={nameOf}
              faceOf={faceOf}
              people={people}
            />
            {now.unpriced
              ? (
                <p className="usage-unpriced">
                  <Icon name="info" size={14} />
                  {now.unpriced.toLocaleString()} {now.unpriced === 1 ? "call has" : "calls have"}
                  {" "}
                  no price: their models aren't in the catalog, and the app sets no rate for them.
                  Their tokens are counted all the same.
                </p>
              )
              : null}
          </>
        )
        : (
          <Card className="usage-empty">
            <EmptyState icon="chart" title={`Nothing used in ${period}`}>
              {everyone
                ? "As agents answer in this org, what each call used and what it cost shows here, by person, agent and model."
                : "As agents answer for you, what each call used and what it cost shows here."}
            </EmptyState>
          </Card>
        )}
    </div>
  );
}

/** A headline number: its label, the value, how it changed from the period before. */
function Tile(
  { label, value, delta, span, note }: {
    label: string;
    value: string;
    delta?: number;
    span?: number;
    note?: string;
  },
): ReactNode {
  const up = delta !== undefined && delta > 0.005;
  const down = delta !== undefined && delta < -0.005;
  return (
    <div className="usage-tile">
      <span className="usage-tile-label">{label}</span>
      <span className="usage-tile-value">{value}</span>
      <span className="usage-tile-note">
        {delta !== undefined && span
          ? (
            <span className="usage-delta" data-way={up ? "up" : down ? "down" : "flat"}>
              {up ? "↑" : down ? "↓" : "→"} {times(delta)}
              <span className="usage-delta-against">vs the {span} days before</span>
            </span>
          )
          : note
          ? note
          : span
          ? <span className="usage-delta-against">Nothing the {span} days before</span>
          : null}
        {delta !== undefined && note ? <span className="usage-tile-more">{note}</span> : null}
      </span>
    </div>
  );
}

/** A change in words: a percentage, or how many times over once it's ten. */
const times = (delta: number) =>
  delta >= 9 ? `${Math.round(1 + delta)}×` : `${Math.abs(Math.round(delta * 100))}%`;

/** Shown at first, of a long list: the rest a press away. */
const FIRST = 6;

/** Groups largest first: each one's name, its measure, its share as a bar, its other measures. */
function Breakdown(
  { title, groups, measure, name, detail, face, hint }: {
    title: string;
    groups: Group[];
    measure: Measure;
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
                  measure !== "cost" ? usd(g.cost) : null,
                  measure !== "tokens" ? `${compact(g.tokens)} tokens` : null,
                  measure !== "calls" ? `${g.calls.toLocaleString()} calls` : null,
                ].filter(Boolean).join(" · ")}
              </span>
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

/** The latest calls: when, whose, which agent, which model, what they used and cost. */
function Recent(
  { calls, everyone, nameOf, faceOf, people }: {
    calls: Use[];
    everyone: boolean;
    nameOf(person: string): string;
    faceOf(person: string): string;
    people: Map<string, Person>;
  },
): ReactNode {
  if (!calls.length) return null;
  return (
    <Card
      as="section"
      padding="none"
      className="usage-card usage-recent"
      aria-labelledby="usage-recent"
    >
      <header className="usage-card-head usage-recent-head">
        <h3 id="usage-recent">Latest calls</h3>
        <p>{everyone ? "Everyone's" : "Yours"}</p>
      </header>
      <div className="usage-recent-scroll">
        <table className="usage-table usage-calls">
          <thead>
            <tr>
              <th scope="col">When</th>
              {everyone ? <th scope="col">Who</th> : null}
              <th scope="col">Agent</th>
              <th scope="col">Model</th>
              <th scope="col" className="usage-num">In</th>
              <th scope="col" className="usage-num">Out</th>
              <th scope="col" className="usage-num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => {
              const person = c.tags?.person ?? "";
              const model = modelOf(c.subject);
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
                  <td className="usage-num">{compact(c.quantities.output ?? 0)}</td>
                  <td className="usage-num">
                    {c.unpriced?.includes("cost")
                      ? <span className="usage-quiet" title="No price for this model">—</span>
                      : usd(c.cost ?? 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
