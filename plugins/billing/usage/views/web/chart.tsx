/**
 * A period, day by day: one column per day of what's measured (cost,
 * tokens, calls), in the theme's first chart colour, on hairline gridlines
 * at round values. Hovering or focusing a day (arrow keys move) shows its
 * numbers; the same numbers are a table a press away. Plain SVG, drawn at
 * the width it has.
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
import { compact, type Day, type Measure, niceMax, said, usd } from "./numbers.ts";

const PAD = { top: 14, right: 6, bottom: 28, left: 46 };

/** A column's path: rounded at its top, square at the baseline. */
function column(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${
    x + width
  },${y + r}V${y + height}Z`;
}

const longDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

const shortDay = (day: string, few: boolean) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(
    undefined,
    few
      ? { weekday: "short", timeZone: "UTC" }
      : { month: "short", day: "numeric", timeZone: "UTC" },
  );

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

export function DailyChart(
  { days, measure, label, height = 210 }: {
    days: Day[];
    measure: Measure;
    /** What it shows, for screen readers: "Cost per day". */
    label: string;
    height?: number;
  },
): ReactNode {
  const [box, width] = useWidth<HTMLDivElement>();
  const [at, setAt] = useState<number>();
  const [table, setTable] = useState(false);
  const id = useId();
  useEffect(() => setAt(undefined), [days, measure]);
  const values = days.map((d) => d[measure]);
  const top = niceMax(Math.max(...values, 0));
  const plot = { w: Math.max(0, width - PAD.left - PAD.right), h: height - PAD.top - PAD.bottom };
  const slot = days.length ? plot.w / days.length : 0;
  const bar = Math.max(2, Math.min(24, slot * 0.72, slot - 2));
  const y = (v: number) => PAD.top + plot.h - (v / top) * plot.h;
  const ticks = [0, top / 2, top];
  const few = days.length <= 7;
  const every = few ? 1 : Math.ceil(days.length / (width < 480 ? 4 : 6));
  const shownDay = at === undefined ? undefined : days[at];
  const keys = (event: KeyboardEvent<SVGSVGElement>) => {
    const last = days.length - 1;
    const next: Record<string, number> = {
      ArrowRight: Math.min(last, (at ?? -1) + 1),
      ArrowLeft: Math.max(0, (at ?? days.length) - 1),
      Home: 0,
      End: last,
    };
    if (!(event.key in next)) return;
    event.preventDefault();
    setAt(next[event.key]);
  };
  return (
    <div className="usage-chart">
      <div className="usage-chart-plot" ref={box} style={{ height }}>
        {width
          ? (
            <svg
              width={width}
              height={height}
              role="group"
              aria-label={`${label}: arrow keys move between days`}
              aria-describedby={`${id}-now`}
              tabIndex={0}
              onKeyDown={keys}
              onBlur={() => setAt(undefined)}
              onPointerLeave={() => setAt(undefined)}
            >
              {ticks.map((t) => (
                <g key={t} className="usage-tick">
                  <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
                  <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                    {measure === "cost" ? usd(t) : compact(t)}
                  </text>
                </g>
              ))}
              {days.map((d, i) => {
                const v = d[measure];
                const h = (v / top) * plot.h;
                const x = PAD.left + i * slot + (slot - bar) / 2;
                return (
                  <g key={d.day} className="usage-day" data-on={i === at || undefined}>
                    {v > 0 ? <path d={column(x, y(v), bar, Math.max(1, h))} /> : null}
                    <rect
                      className="usage-hit"
                      x={PAD.left + i * slot}
                      y={PAD.top}
                      width={slot}
                      height={plot.h + 6}
                      onPointerEnter={() => setAt(i)}
                      onPointerDown={() => setAt(i)}
                    />
                    {i % every === (days.length - 1) % every
                      ? (
                        <text
                          className="usage-axis"
                          x={PAD.left + i * slot + slot / 2}
                          y={height - 8}
                          textAnchor="middle"
                        >
                          {shortDay(d.day, few)}
                        </text>
                      )
                      : null}
                  </g>
                );
              })}
            </svg>
          )
          : null}
        {shownDay && width
          ? (
            <div
              className="usage-tip"
              style={{
                left: Math.min(
                  Math.max(PAD.left + at! * slot + slot / 2, 90),
                  width - 90,
                ),
                top: Math.max(0, y(shownDay[measure]) - 10),
              }}
              aria-hidden="true"
            >
              <span className="usage-tip-day">{longDay(shownDay.day)}</span>
              <span className="usage-tip-value">{said(shownDay[measure], measure)}</span>
              <span className="usage-tip-rest">
                {measure !== "cost" ? `${usd(shownDay.cost)} · ` : ""}
                {measure !== "tokens" ? `${compact(shownDay.tokens)} tokens · ` : ""}
                {measure !== "calls"
                  ? `${shownDay.calls} ${shownDay.calls === 1 ? "call" : "calls"}`
                  : `${compact(shownDay.tokens)} tokens`}
              </span>
            </div>
          )
          : null}
        <span id={`${id}-now`} className="usage-sr" aria-live="polite">
          {shownDay
            ? `${longDay(shownDay.day)}: ${usd(shownDay.cost)}, ${
              compact(shownDay.tokens)
            } tokens, ${shownDay.calls} calls`
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
          {table ? "Hide the numbers" : "Show the numbers"}
        </Button>
      </div>
      {table
        ? (
          <div className="usage-table-box" id={`${id}-table`}>
            <table className="usage-table">
              <caption className="usage-sr">{label}</caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col" className="usage-num">Cost</th>
                  <th scope="col" className="usage-num">Tokens</th>
                  <th scope="col" className="usage-num">Calls</th>
                </tr>
              </thead>
              <tbody>
                {[...days].reverse().map((d) => (
                  <tr key={d.day}>
                    <th scope="row">{longDay(d.day)}</th>
                    <td className="usage-num">{usd(d.cost)}</td>
                    <td className="usage-num">{d.tokens.toLocaleString()}</td>
                    <td className="usage-num">{d.calls.toLocaleString()}</td>
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
