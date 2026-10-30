/**
 * A recording to listen to: play and pause, its waveform (from `peaks`,
 * flat without) as the progress bar, which seeks by a click, a drag or the
 * arrow keys, and its length, or how far it has played. `duration`
 * (milliseconds) is shown before the audio loads, and stands in for
 * recordings that don't say theirs. One plays at a time: starting another
 * pauses it. On a surface: `card` (the default), `muted` (as others'
 * messages are), `bubble` (as the reader's own are) or `bare` (its
 * parent's). What goes beneath it on that surface (a transcript, a caption)
 * is its `children`.
 *
 * ```tsx
 * <AudioPlayer src={`/files/${id}`} duration={6200} peaks={peaks} label="Voice message" />
 * ```
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { clock } from "./clock.ts";
import { cx } from "./cx.ts";
import { Icon } from "./icon.tsx";
import { sheet } from "./sheet.tsx";
import { Spinner } from "./spinner.tsx";
import { Waveform } from "./waveform.tsx";

const SHEET = sheet(
  "audio-player",
  `
.copilotz-audio { --audio-fg: var(--foreground); --audio-on: var(--background);
  display: grid; gap: 2px; width: 340px; max-width: 100%; min-width: 0; padding: 7px 14px 7px 7px;
  border: 1px solid var(--border); border-radius: var(--radius-2xl); background: var(--card);
  color: var(--card-foreground); box-shadow: var(--shadow-sm); }
.copilotz-audio-muted { border-color: transparent; background: var(--muted); color: var(--foreground); box-shadow: none; }
.copilotz-audio-bubble { --audio-fg: var(--bubble-foreground); --audio-on: var(--bubble); border-color: transparent;
  background: var(--bubble); color: var(--bubble-foreground); box-shadow: none; }
.copilotz-audio-bare { width: 100%; padding: 0; border: 0; border-radius: 0; background: none; color: inherit;
  box-shadow: none; }
.copilotz-audio-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.copilotz-audio-play { flex: none; display: grid; place-items: center; width: 36px; height: 36px; padding: 0;
  border: 0; border-radius: var(--radius-full); background: var(--audio-fg); color: var(--audio-on);
  cursor: pointer; transition: opacity .15s, transform .1s; }
.copilotz-audio-play:hover:not(:disabled) { opacity: .86; }
.copilotz-audio-play:active:not(:disabled) { transform: scale(.94); }
.copilotz-audio-play:disabled { cursor: default; opacity: .55; }
.copilotz-audio-play .copilotz-icon-play { margin-left: 2px; }
.copilotz-audio-failed .copilotz-audio-play { background: var(--destructive-soft); color: var(--destructive-text); }
.copilotz-audio-row > .copilotz-waveform { flex: 1; color: var(--audio-fg); }
.copilotz-audio-time { flex: none; min-width: 36px; text-align: right; font-size: 12px; line-height: 1;
  font-variant-numeric: tabular-nums; color: color-mix(in oklab, currentColor 72%, transparent); }
.copilotz-audio-more { min-width: 0; padding-left: 46px; }
.copilotz-audio-bare .copilotz-audio-more { padding-right: 0; }
@media (pointer: coarse) { .copilotz-audio-play { width: 40px; height: 40px; } .copilotz-audio-more { padding-left: 50px; } }
`,
);

/** The one playing now: starting another pauses it. */
let current: HTMLAudioElement | undefined;

export function AudioPlayer(
  {
    src,
    duration,
    peaks,
    label = "Audio",
    variant = "card",
    bars,
    className,
    children,
  }: {
    /** Where the audio is (a URL, or an object URL); none while it isn't ready. */
    src?: string;
    duration?: number;
    peaks?: readonly number[];
    /** What it is, for screen readers ("Voice message"). */
    label?: string;
    variant?: "card" | "muted" | "bubble" | "bare";
    /** The waveform's bars: as many as fit, unless given. */
    bars?: number;
    className?: string;
    children?: ReactNode;
  },
): ReactNode {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [at, setAt] = useState(0);
  const [measured, setMeasured] = useState<number>();
  const [failed, setFailed] = useState(false);
  const total = measured ?? (duration ? duration / 1000 : 0);

  // While it plays, the waveform fills smoothly (timeupdate alone is a few times a second).
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() {
      if (audio.current) setAt(audio.current.currentTime);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  // Taken off the page, it stops.
  useEffect(() => () => {
    const element = audio.current;
    element?.pause();
    if (current === element) current = undefined;
  }, []);
  useEffect(() => {
    setFailed(false);
    setMeasured(undefined);
    setAt(0);
  }, [src]);

  const toggle = () => {
    const element = audio.current;
    if (!element) return;
    if (failed) {
      setFailed(false);
      element.load();
      return;
    }
    if (!element.paused) return element.pause();
    if (current && current !== element) current.pause();
    current = element;
    element.play().catch(() => setPlaying(false));
  };
  const seek = (fraction: number) => {
    const element = audio.current;
    if (!element || !total) return;
    const to = Math.min(fraction * total, Math.max(0, total - 0.05));
    element.currentTime = to;
    setAt(to);
  };
  /** The audio's own length, when it says (recorded WebM says it's endless). */
  const measure = (element: HTMLAudioElement) => {
    const known = Number.isFinite(element.duration) && element.duration > 0;
    if (known) setMeasured(element.duration);
    return known;
  };

  const ready = !!src && !failed;
  const started = playing || at > 0;
  const time = started ? clock(at * 1000) : total ? clock(total * 1000, true) : "–:––";
  const length = total ? clock(total * 1000, true) : undefined;
  return (
    <div
      role="group"
      aria-label={length ? `${label}, ${length}` : label}
      className={cx(
        "copilotz-audio",
        variant !== "card" && `copilotz-audio-${variant}`,
        failed && "copilotz-audio-failed",
        className,
      )}
    >
      {SHEET}
      <div className="copilotz-audio-row">
        <button
          type="button"
          className="copilotz-audio-play"
          onClick={toggle}
          disabled={!src}
          aria-label={failed
            ? `Couldn't load the ${label.toLowerCase()}. Try again`
            : !src
            ? "Loading"
            : playing
            ? "Pause"
            : "Play"}
        >
          {!src || (playing && waiting)
            ? <Spinner size={14} />
            : failed
            ? <Icon name="retry" size={16} />
            : playing
            ? <Icon name="pause" size={16} filled />
            : <Icon name="play" size={16} filled className="copilotz-icon-play" />}
        </button>
        <Waveform
          peaks={peaks}
          bars={bars}
          progress={total ? at / total : 0}
          onSeek={seek}
          step={total ? Math.min(0.25, 5 / total) : 0.05}
          disabled={!ready || !total}
          label={`${label}: position`}
          valueText={`${clock(at * 1000)} of ${length ?? "unknown"}`}
        />
        <span className="copilotz-audio-time" aria-hidden="true">{time}</span>
      </div>
      {children ? <div className="copilotz-audio-more">{children}</div> : null}
      {src
        ? (
          <audio
            ref={audio}
            src={src}
            preload="metadata"
            hidden
            onPlay={() => setPlaying(true)}
            onPause={() => {
              setPlaying(false);
              setWaiting(false);
            }}
            onWaiting={() => setWaiting(true)}
            onPlaying={() => setWaiting(false)}
            onEnded={(event) => {
              setPlaying(false);
              setAt(0);
              event.currentTarget.currentTime = 0;
            }}
            onTimeUpdate={(event) => {
              if (!playing) setAt(event.currentTarget.currentTime);
            }}
            onDurationChange={(event) => void measure(event.currentTarget)}
            onLoadedMetadata={(event) => {
              const element = event.currentTarget;
              if (measure(element) || duration) return;
              // Recorded WebM doesn't say how long it is until it's read through: seeking far
              // past its end reads it, and measures it.
              const settle = () => {
                element.removeEventListener("timeupdate", settle);
                element.currentTime = 0;
                measure(element);
              };
              element.addEventListener("timeupdate", settle);
              element.currentTime = 1e101;
            }}
            onError={() => {
              setFailed(true);
              setPlaying(false);
            }}
          />
        )
        : null}
    </div>
  );
}
