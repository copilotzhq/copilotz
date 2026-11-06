/**
 * A month, day by day: one column per day of what was spent, stacked by what
 * the page groups by (each series in the theme's chart colours, in order;
 * the rest as one, in grey), a 2px gap of the card's colour between
 * segments, on hairline gridlines at round values. Days to come are an
 * empty track, and today is marked. One series chosen (the page's filter
 * in this dimension), the others step back. Hovering or focusing a day
 * (arrow keys move) shows what each spent; the same numbers are a table a
 * press away. Plain SVG, drawn at the width it has.
 */
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "../../../../../hosts/web/mod.ts";
import { formatDate } from "../../../../../hosts/web/mod.ts";
import { type Column, niceMax, usd } from "./numbers.ts";
import { say } from "./words.ts";

const PAD = { top: 14, right: 6, bottom: 28, left: 46 };
/** The gap between a column's segments, in the card's colour. */
const GAP = 2;

/** A series as the chart draws it: its name, and its colour (a CSS value). */
export type Series = { key: string; name: string; color: string };

/** A column's top segment: rounded at its top, square at its foot. */
function rounded(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${
    x + width
  },${y + r}V${y + height}Z`;
}

export const longDay = (day: string): string =>
  formatDate(new Date(`${day}T12:00:00Z`), {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

const shortDay = (day: string) =>
  formatDate(new Date(`${day}T12:00:00Z`), {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/** The width an element has, kept current. */
function useWidth<E extends HTMLElement>(): [RefObject<E | null>, number] {
  const ref = useRef<E>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function StackedChart(
  { columns, series, today, chosen, label, height = 220 }: {
    columns: Column[];
    /** In stacking order, from the foot: the columns' values are in the same order. */
    series: Series[];
    /** Today's day, when the month is this one: later days are still to come. */
    today?: string;
    /** The series the page keeps to, if any: the others step back. */
    chosen?: number;
    /** What it shows, for screen readers: "Spend per day, by kind". */
    label: string;
    height?: number;
  },
): ReactNode {
  const [box, width] = useWidth<HTMLDivElement>();
  const [at, setAt] = useState<number>();
  const [table, setTable] = useState(false);
  const id = useId();
  useEffect(() => setAt(undefined), [columns, series]);
  const top = niceMax(Math.max(...columns.map((c) => c.spend), 0));
  const plot = { w: Math.max(0, width - PAD.left - PAD.right), h: height - PAD.top - PAD.bottom };
  const slot = columns.length ? plot.w / columns.length : 0;
  const bar = Math.max(3, Math.min(22, slot * 0.68, slot - 2));
  const base = PAD.top + plot.h;
  const y = (v: number) => base - (v / top) * plot.h;
  const ticks = [0, top / 2, top];
  const every = Math.ceil(columns.length / (width < 480 ? 4 : 7));
  const shown = at === undefined ? undefined : columns[at];
  const keys = (event: KeyboardEvent<SVGSVGElement>) => {
    const last = columns.length - 1;
    const next: Record<string, number> = {
      ArrowRight: Math.min(last, (at ?? -1) + 1),
      ArrowLeft: Math.max(0, (at ?? columns.length) - 1),
      Home: 0,
      End: last,
    };
    if (!(event.key in next)) return;
    event.preventDefault();
    setAt(next[event.key]);
  };
  /** A day's column: its series from the foot up, a gap between, the top one rounded. */
  const marks = (c: Column, x: number): ReactNode => {
    if (!(c.spend > 0)) return null;
    const parts = c.values.map((v, i) => ({ v, i })).filter((p) => p.v > 0);
    let foot = base;
    return parts.map(({ v, i }, n) => {
      const whole = (v / top) * plot.h;
      const last = n === parts.length - 1;
      // Each keeps at least a sliver, less the gap above it.
      const h = Math.max(last ? 1 : 2, whole) - (last ? 0 : GAP);
      const y0 = foot - h;
      foot = y0 - (last ? 0 : GAP);
      const style = { fill: series[i]?.color };
      const back = chosen !== undefined && i !== chosen;
      return last
        ? (
          <path
            key={i}
            d={rounded(x, y0, bar, h)}
            style={style}
            data-back={back || undefined}
          />
        )
        : (
          <rect
            key={i}
            x={x}
            y={y0}
            width={bar}
            height={Math.max(0.5, h)}
            style={style}
            data-back={back || undefined}
          />
        );
    });
  };
  const named = (c: Column) =>
    c.values.map((v, i) => ({ v, i })).filter((p) => p.v > 0).sort((a, b) => b.v - a.v);
  return (
    <div className="usage-chart">
      <div className="usage-chart-plot" ref={box} style={{ height }}>
        {width
          ? (
            <svg
              width={width}
              height={height}
              role="group"
              aria-label={say("chartKeys", { label })}
              aria-describedby={`${id}-now`}
              tabIndex={0}
              onKeyDown={keys}
              onBlur={() => setAt(undefined)}
              onPointerLeave={() => setAt(undefined)}
            >
              {ticks.map((t) => (
                <g key={t} className="usage-tick">
                  <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
                  <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">{usd(t)}</text>
                </g>
              ))}
              {columns.map((c, i) => {
                const x = PAD.left + i * slot + (slot - bar) / 2;
                const later = today !== undefined && c.day > today;
                return (
                  <g
                    key={c.day}
                    className="usage-day"
                    data-on={i === at || undefined}
                    data-later={later || undefined}
                  >
                    {later
                      ? (
                        <rect
                          className="usage-later"
                          x={x}
                          y={base - 3}
                          width={bar}
                          height={3}
                          rx={1.5}
                        />
                      )
                      : marks(c, x)}
                    {c.day === today
                      ? <circle className="usage-today" cx={x + bar / 2} cy={base + 7} r={2.5} />
                      : null}
                    <rect
                      className="usage-hit"
                      x={PAD.left + i * slot}
                      y={PAD.top}
                      width={slot}
                      height={plot.h + 6}
                      onPointerEnter={() => setAt(i)}
                      onPointerDown={() => setAt(i)}
                    />
                    {i % every === 0
                      ? (
                        <text
                          className="usage-axis"
                          x={PAD.left + i * slot + slot / 2}
                          y={height - 6}
                          textAnchor="middle"
                        >
                          {shortDay(c.day)}
                        </text>
                      )
                      : null}
                  </g>
                );
              })}
            </svg>
          )
          : null}
        {shown && width
          ? (
            <div
              className="usage-tip"
              style={{
                left: Math.min(Math.max(PAD.left + at! * slot + slot / 2, 100), width - 100),
                top: Math.max(0, y(shown.spend) - 10),
              }}
              aria-hidden="true"
            >
              <span className="usage-tip-day">{longDay(shown.day)}</span>
              <span className="usage-tip-value">
                {today !== undefined && shown.day > today ? say("stillToCome") : usd(shown.spend)}
              </span>
              {named(shown).slice(0, 6).map(({ v, i }) => (
                <span key={i} className="usage-tip-row">
                  <i className="usage-key" style={{ background: series[i]?.color }} />
                  <span className="usage-tip-name">{series[i]?.name}</span>
                  <span className="usage-tip-num">{usd(v)}</span>
                </span>
              ))}
            </div>
          )
          : null}
        <span id={`${id}-now`} className="usage-sr" aria-live="polite">
          {shown
            ? [
              say("dayAnnounced", { day: longDay(shown.day), spend: usd(shown.spend) }),
              ...named(shown).map(({ v, i }) =>
                say("seriesAnnounced", { name: series[i]?.name ?? "", amount: usd(v) })
              ),
            ].join(", ")
            : ""}
        </span>
      </div>
      <div className="usage-chart-foot">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={table}
          aria-controls={`${id}-table`}
          onClick={() => setTable(!table)}
        >
          {table ? say("hideNumbers") : say("showNumbers")}
        </Button>
      </div>
      {table
        ? (
          <div className="usage-table-box" id={`${id}-table`}>
            <table className="usage-table">
              <caption className="usage-sr">{label}</caption>
              <thead>
                <tr>
                  <th scope="col">{say("day")}</th>
                  <th scope="col" className="usage-num">{say("spend")}</th>
                  {series.map((s) => <th key={s.key} scope="col" className="usage-num">{s.name}
                  </th>)}
                </tr>
              </thead>
              <tbody>
                {[...columns].filter((c) => today === undefined || c.day <= today).reverse().map((
                  c,
                ) => (
                  <tr key={c.day}>
                    <th scope="row">{longDay(c.day)}</th>
                    <td className="usage-num">{usd(c.spend)}</td>
                    {series.map((s, i) => (
                      <td key={s.key} className="usage-num">
                        {c.values[i] ? usd(c.values[i]) : <span className="usage-quiet">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        : null}
    </div>
  );
}
