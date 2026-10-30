/**
 * Sound as bars, in the text's colour: a recording's `peaks` (its loudness,
 * 0 to 1) as `bars` bars (as many as fit, unless given) scaled to the
 * loudest, what has played
 * (`progress`, 0 to 1) solid and the rest faint. Without peaks it's flat,
 * for audio of unknown shape. Given `onSeek`, it's the recording's
 * position as a slider: a click or a drag seeks, and so do the arrow keys
 * (by `step`), Page Up and Down, Home and End. `live` draws levels as they
 * come instead, unscaled, the newest at the end and the oldest falling off
 * the start.
 *
 * ```tsx
 * <Waveform peaks={peaks} progress={0.4} onSeek={seek} label="Position" valueText="0:04 of 0:10" />
 * ```
 */
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cx } from "./cx.ts";
import { resample } from "./resample.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "waveform",
  `
.copilotz-waveform { display: flex; align-items: center; justify-content: space-between; gap: 2px; min-width: 0;
  height: 28px; user-select: none; -webkit-user-select: none; }
.copilotz-waveform i { flex: 0 1 3px; min-width: 1.5px; height: max(3px, calc(var(--level) * 100%));
  border-radius: var(--radius-full); background: currentColor; opacity: .3; transition: opacity .12s; }
.copilotz-waveform i.copilotz-waveform-on { opacity: 1; }
.copilotz-waveform-seek { cursor: pointer; touch-action: pan-y; border-radius: var(--radius-xs); }
.copilotz-waveform-seek:focus-visible { outline-offset: 4px; }
.copilotz-waveform[aria-disabled=true] { cursor: default; }
.copilotz-waveform-live { justify-content: flex-end; gap: 2px; overflow: hidden; }
.copilotz-waveform-live i { flex: none; width: 3px; opacity: .9; transition: height .08s linear; }
.copilotz-waveform-live i.copilotz-waveform-idle { opacity: .22; }
`,
);

/** How tall a bar is at least, of the waveform's height, so silence still shows. */
const FLOOR = 0.12;
/** The loudness a recording is scaled to at least: quiet ones stay quiet. */
const LOUD = 0.3;
/** A recording of unknown shape: bars of one height. */
const FLAT = 0.3;

/** Pixels a bar takes with the gap after it, and some air: how many fit. */
const PITCH = 5.5;

const style = (level: number) => ({ "--level": level.toFixed(3) }) as CSSProperties;

export function Waveform(
  {
    peaks,
    bars,
    progress = 0,
    onSeek,
    step = 0.05,
    label,
    valueText,
    disabled,
    live,
    className,
  }: {
    peaks?: readonly number[];
    /** How many bars. A `live` one keeps this many (120), and pads with quiet ones at first. */
    bars?: number;
    progress?: number;
    /** Where to play from, 0 to 1: the waveform is a slider. */
    onSeek?(fraction: number): void;
    /** How far an arrow key moves, 0 to 1. */
    step?: number;
    /** What the slider is, for screen readers. */
    label?: string;
    /** Its position in words ("0:04 of 0:10"). */
    valueText?: string;
    disabled?: boolean;
    live?: boolean;
    className?: string;
  },
): ReactNode {
  const dragging = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<number>();
  // As many bars as its width holds, kept so as it changes.
  useLayoutEffect(() => {
    const el = box.current;
    if (bars !== undefined || live || !el || typeof ResizeObserver === "undefined") return;
    const measure = () =>
      setFit(Math.max(12, Math.min(96, Math.floor((el.clientWidth + 2) / PITCH))));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bars, live]);

  if (live) {
    const count = bars ?? 120;
    const levels = (peaks ?? []).slice(-count);
    return (
      <div
        className={cx("copilotz-waveform", "copilotz-waveform-live", className)}
        aria-hidden="true"
      >
        {SHEET}
        {Array.from(
          { length: count - levels.length },
          (_, i) => <i key={`idle${i}`} className="copilotz-waveform-idle" style={style(FLOOR)} />,
        )}
        {levels.map((level, i) => <i key={i} style={style(Math.max(FLOOR, level))} />)}
      </div>
    );
  }

  const count = bars ?? fit ?? 40;
  const shaped = peaks?.length ? resample(peaks, count) : undefined;
  const top = Math.max(LOUD, ...(shaped ?? []));
  const levels = shaped?.map((p) => Math.max(FLOOR, Math.min(1, p / top))) ??
    Array.from({ length: count }, () => FLAT);
  const played = Math.min(1, Math.max(0, progress));
  const drawn = levels.map((level, i) => (
    <i
      key={i}
      className={(i + 0.5) / levels.length <= played ? "copilotz-waveform-on" : undefined}
      style={style(level)}
    />
  ));
  if (!onSeek) {
    return (
      <div ref={box} className={cx("copilotz-waveform", className)} aria-hidden="true">
        {SHEET}
        {drawn}
      </div>
    );
  }

  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const seekAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width) onSeek(clamp((event.clientX - box.left) / box.width));
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const moves: Record<string, number> = {
      ArrowRight: played + step,
      ArrowUp: played + step,
      ArrowLeft: played - step,
      ArrowDown: played - step,
      PageUp: played + 0.1,
      PageDown: played - 0.1,
      Home: 0,
      End: 1,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    onSeek(clamp(moves[event.key]));
  };
  return (
    <div
      ref={box}
      className={cx("copilotz-waveform", "copilotz-waveform-seek", className)}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(played * 100)}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      onKeyDown={keys}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
        seekAt(event);
      }}
      onPointerMove={(event) => {
        if (dragging.current) seekAt(event);
      }}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      onLostPointerCapture={() => (dragging.current = false)}
    >
      {SHEET}
      {drawn}
    </div>
  );
}
