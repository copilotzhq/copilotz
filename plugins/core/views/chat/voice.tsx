/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/**
 * Voice messages: recording in the composer (a live waveform and timer,
 * Cancel, Stop to listen back, Send) and the compact player a voice message
 * shows as, with its transcript one click away.
 * @module
 */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowUp,
  ChevronRight,
  Mic,
  MicOff,
  Pause,
  Play,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  Button,
  cn,
  formatDuration,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@copilotz/copilotz/web/kit";
import { VOICE_PEAKS } from "../../shared/chat-messages.ts";

type Track = { stop(): void };
type Stream = { getTracks(): Track[] };
type RecorderLike = {
  state: string;
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
};
type RecorderClass = {
  new (
    stream: Stream,
    options?: { mimeType?: string; audioBitsPerSecond?: number },
  ): RecorderLike;
  isTypeSupported?(type: string): boolean;
};
type Analyser = {
  fftSize: number;
  getByteTimeDomainData(data: Uint8Array): void;
};
type AudioContextLike = {
  resume?(): Promise<void>;
  createAnalyser(): Analyser;
  createMediaStreamSource(stream: Stream): { connect(node: unknown): void };
  close(): Promise<void>;
};
type Globals = {
  navigator?: {
    mediaDevices?: { getUserMedia(constraints: unknown): Promise<Stream> };
  };
  MediaRecorder?: RecorderClass;
  AudioContext?: new () => AudioContextLike;
  webkitAudioContext?: new () => AudioContextLike;
  performance?: { now(): number };
  requestAnimationFrame?(callback: () => void): number;
  cancelAnimationFrame?(handle: number): void;
};
const scope = globalThis as unknown as Globals;
const clock = () => scope.performance?.now() ?? Date.now();

/** Whether this browser can record audio for a voice message. */
export function canRecordVoice(): boolean {
  return Boolean(
    scope.navigator?.mediaDevices?.getUserMedia && scope.MediaRecorder,
  );
}

/**
 * Recording formats in order of preference: Opus in WebM (Chrome, Firefox,
 * Android, recent Safari), Ogg, then AAC in MP4 (older iOS Safari).
 */
const FORMATS = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/aac",
];

/** The best format this browser records, if it says. */
export function recordingFormat(): string | undefined {
  const supported = scope.MediaRecorder?.isTypeSupported;
  if (!supported) return undefined;
  return FORMATS.find((type) => {
    try {
      return supported.call(scope.MediaRecorder, type);
    } catch {
      return false;
    }
  });
}

function extension(mediaType: string): string {
  return mediaType.includes("webm")
    ? "webm"
    : mediaType.includes("ogg")
    ? "ogg"
    : mediaType.includes("mp4") || mediaType.includes("aac")
    ? "m4a"
    : "audio";
}

/** The longest voice message; recording stops there for review. */
export const MAX_RECORDING_MS = 10 * 60_000;
const SAMPLE_MS = 50;
/** Enough live bars to fill a wide composer; narrow ones show the newest. */
const LIVE_BARS = 120;

/** A finished recording, ready to send. */
export type VoiceTake = Readonly<{
  file: File;
  durationMs: number;
  /** Peak levels (0–1) across the recording, for its waveform. */
  peaks: readonly number[];
}>;

/** What the recording bar shows. */
export type VoiceSnapshot = Readonly<{
  phase: "starting" | "recording" | "stopping" | "review" | "error";
  elapsedMs: number;
  /** The latest levels (0–1), oldest first: the live waveform. */
  levels: readonly number[];
  /** How many levels were sampled in all (keys the live bars). */
  sampled: number;
  take?: VoiceTake;
  error?: string;
  /** Microphone access was refused: allowing it in the browser fixes it. */
  denied?: boolean;
  /** Recording stopped at {@link MAX_RECORDING_MS}. */
  limited?: boolean;
}>;

/** One recording: observable, then stopped (kept) or cancelled. */
export interface VoiceRecorder {
  subscribe(listener: () => void): () => void;
  getSnapshot(): VoiceSnapshot;
  /** Stop and keep the take; it resolves without one when nothing usable was recorded. */
  stop(): Promise<VoiceTake | undefined>;
  /** Stop and discard, releasing the microphone. */
  cancel(): void;
}

/** Plain words for why the microphone didn't start. */
function microphoneError(
  error: unknown,
): { message: string; denied?: boolean } {
  const name = (error as { name?: unknown } | undefined)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      message:
        "Microphone access is blocked. Allow it for this site in your browser settings, then try again.",
      denied: true,
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return { message: "No microphone was found." };
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return {
      message:
        "The microphone is busy. Close other apps using it and try again.",
    };
  }
  return { message: "The microphone couldn't start." };
}

/** At most `count` levels: the average loudness of each stretch. */
function downsample(levels: readonly number[], count: number): number[] {
  const bars = Math.min(count, levels.length);
  return Array.from({ length: bars }, (_, index) => {
    const from = Math.floor(index * levels.length / bars);
    const to = Math.max(
      from + 1,
      Math.floor((index + 1) * levels.length / bars),
    );
    let sum = 0;
    for (let at = from; at < to; at++) sum += levels[at];
    return Math.round(sum / (to - from) * 100) / 100;
  });
}

/**
 * Starts recording a voice message. Call it from the click that asks to
 * record: the audio meter starts inside that gesture, which some browsers
 * (iOS Safari) require.
 */
export function recordVoice(
  options: { maxMs?: number } = {},
): VoiceRecorder {
  const max = options.maxMs ?? MAX_RECORDING_MS;
  const listeners = new Set<() => void>();
  let snapshot: VoiceSnapshot = {
    phase: "starting",
    elapsedMs: 0,
    levels: [],
    sampled: 0,
  };
  const update = (patch: Partial<VoiceSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  let cancelled = false;
  let stream: Stream | undefined;
  let recorder: RecorderLike | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;
  // When Stop was pressed: the encoder may take a moment to finish after.
  let stoppedAt: number | undefined;
  const chunks: Blob[] = [];
  const levels: number[] = [];
  let finish: (take: VoiceTake | undefined) => void = () => {};
  const done = new Promise<VoiceTake | undefined>((resolve) => {
    finish = resolve;
  });
  let context: AudioContextLike | undefined;
  try {
    const Context = scope.AudioContext ?? scope.webkitAudioContext;
    context = Context ? new Context() : undefined;
  } catch {
    context = undefined; // The meter is optional; recording is not.
  }
  const halt = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const release = () => {
    halt();
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    void context?.close().catch(() => {});
    context = undefined;
  };
  const fail = (error: string, denied = false) => {
    release();
    update({ phase: "error", error, ...(denied ? { denied } : {}) });
    finish(undefined);
  };
  const stop = (): Promise<VoiceTake | undefined> => {
    if (recorder?.state === "recording") {
      stoppedAt = clock();
      halt();
      update({ phase: "stopping" });
      recorder.stop();
    } else if (snapshot.phase === "starting") cancel();
    return done;
  };
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (recorder?.state === "recording") recorder.stop();
    else release();
    finish(undefined);
  };
  const media = scope.navigator?.mediaDevices;
  if (!media?.getUserMedia || !scope.MediaRecorder) {
    fail("This browser can't record audio.");
  } else {
    media.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    }).then((granted) => {
      if (cancelled) {
        granted.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = granted;
      const format = recordingFormat();
      try {
        recorder = new scope.MediaRecorder!(granted, {
          ...(format ? { mimeType: format } : {}),
          // Speech needs little: small uploads, fast transcription.
          audioBitsPerSecond: 32_000,
        });
      } catch {
        return fail("This browser can't record audio.");
      }
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (!cancelled) fail("Recording stopped unexpectedly. Try again.");
      };
      recorder.onstop = () => {
        const durationMs = Math.round((stoppedAt ?? clock()) - startedAt);
        release();
        if (cancelled) return finish(undefined);
        // The container is enough: no codec parameters in the media type.
        const mediaType =
          (recorder?.mimeType || format || "audio/webm").split(";")[0]
            .trim() || "audio/webm";
        const blob = new Blob(chunks, { type: mediaType });
        if (!blob.size || durationMs < 400) {
          update({
            phase: "error",
            error: "That was too short to send. Try again.",
          });
          return finish(undefined);
        }
        const take: VoiceTake = {
          file: new File([blob], `voice-message.${extension(mediaType)}`, {
            type: mediaType,
          }),
          durationMs,
          peaks: downsample(levels, VOICE_PEAKS),
        };
        update({ phase: "review", elapsedMs: durationMs, take });
        finish(take);
      };
      try {
        recorder.start(250);
      } catch {
        return fail("The microphone couldn't start.");
      }
      startedAt = clock();
      update({ phase: "recording" });
      let analyser: Analyser | undefined;
      let data: Uint8Array | undefined;
      try {
        if (context) {
          void context.resume?.().catch(() => {});
          analyser = context.createAnalyser();
          analyser.fftSize = 1024;
          context.createMediaStreamSource(granted).connect(analyser);
          data = new Uint8Array(analyser.fftSize);
        }
      } catch {
        analyser = undefined;
      }
      timer = setInterval(() => {
        const elapsedMs = clock() - startedAt;
        let level = 0;
        if (analyser && data) {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (const value of data) {
            const centered = (value - 128) / 128;
            sum += centered * centered;
          }
          // Loudness, compressed so quiet speech still moves the bars.
          level = Math.min(1, Math.sqrt(Math.sqrt(sum / data.length)) * 1.5);
        }
        levels.push(level);
        update({
          elapsedMs,
          levels: levels.slice(-LIVE_BARS),
          sampled: levels.length,
        });
        if (elapsedMs >= max) {
          update({ limited: true });
          void stop();
        }
      }, SAMPLE_MS);
    }, (error: unknown) => {
      if (cancelled) return;
      const reason = microphoneError(error);
      fail(reason.message, reason.denied);
    });
  }
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    stop,
    cancel,
  };
}

function LiveWaveform(
  { levels, sampled }: { levels: readonly number[]; sampled: number },
): React.ReactElement {
  // Bars keep their sample's key, so new ones enter on the right.
  const first = sampled - levels.length;
  const padding = Math.max(0, LIVE_BARS - levels.length);
  return (
    <span
      aria-hidden="true"
      data-slot="voice-level"
      className="flex h-8 min-w-0 flex-1 items-center justify-end gap-[3px] overflow-hidden"
    >
      {Array.from({ length: padding }, (_, index) => (
        <span
          key={`idle:${index}`}
          className="bg-foreground/15 h-[12%] w-[3px] shrink-0 rounded-full"
        />
      ))}
      {levels.map((level, index) => (
        <span
          key={first + index}
          className="bg-foreground/70 w-[3px] shrink-0 rounded-full"
          style={{ height: `${Math.max(12, Math.round(level * 100))}%` }}
        />
      ))}
    </span>
  );
}

const round =
  "rounded-full [@media(pointer:coarse)]:size-10 [@media(pointer:coarse)]:[&_svg:not([class*='size-'])]:size-5";

/**
 * The composer while recording a voice message: a live waveform and timer,
 * Cancel, Stop to listen back, and Send (which stops and sends at once).
 * Escape cancels. It replaces the text field until sent or cancelled.
 */
export function VoiceComposer(
  {
    recorder,
    onSend,
    onClose,
    onRestart,
    disabled = false,
    focus = false,
  }: {
    recorder: VoiceRecorder;
    onSend(take: VoiceTake): void;
    /** Leave voice mode; the recording is discarded. */
    onClose(): void;
    /** Record again (a new recorder, started from this click). */
    onRestart(event: React.MouseEvent): void;
    disabled?: boolean;
    /**
     * Recording started from the keyboard: focus follows the next step (Send
     * while recording, Try again after an error).
     */
    focus?: boolean;
  },
): React.ReactElement {
  const state = useSyncExternalStore(
    recorder.subscribe,
    recorder.getSnapshot,
    recorder.getSnapshot,
  );
  const group = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const [sending, setSending] = useState(false);
  // A new recorder replaces this one; leaving releases the microphone.
  useEffect(() => () => recorder.cancel(), [recorder]);
  const { phase, take } = state;
  // Keyboard focus follows the next step: Send while recording or after
  // stopping (Enter sends), Try again after an error.
  useEffect(() => {
    if (!focus) return;
    const target = phase === "error"
      ? retry.current
      : phase === "recording" || phase === "review"
      ? primary.current
      : null;
    (target as unknown as { focus?(): void } | null)?.focus?.();
  }, [phase, focus]);
  const discard = () => {
    recorder.cancel();
    onClose();
  };
  // Escape cancels, also when nothing has focus (recording began by a tap).
  const latest = useRef(discard);
  latest.current = discard;
  useEffect(() => {
    const document = (globalThis as {
      document?: {
        body?: unknown;
        addEventListener(
          type: string,
          listener: (event: unknown) => void,
        ): void;
        removeEventListener(
          type: string,
          listener: (event: unknown) => void,
        ): void;
      };
    }).document;
    if (!document) return;
    const onKey = (event: unknown) => {
      const key = event as {
        key?: string;
        target?: unknown;
        defaultPrevented?: boolean;
        preventDefault(): void;
      };
      if (key.key !== "Escape" || key.defaultPrevented) return;
      const node = group.current as unknown as
        | { contains(target: unknown): boolean }
        | null;
      if (key.target !== document.body && !node?.contains(key.target)) return;
      key.preventDefault();
      latest.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const send = () => {
    if (disabled || sending) return;
    if (phase === "review" && take) return onSend(take);
    setSending(true);
    void recorder.stop().then((stopped) => {
      setSending(false);
      if (stopped) onSend(stopped);
    });
  };
  const live = phase === "starting" || phase === "recording" ||
    phase === "stopping";
  const announcement = phase === "starting"
    ? "Starting the microphone."
    : phase === "recording"
    ? "Recording. Press Escape to cancel."
    : phase === "review"
    ? state.limited
      ? "Recording stopped at the time limit. Listen back or send it."
      : "Recording stopped. Listen back or send it."
    : "";
  return (
    <div
      ref={group}
      data-slot="voice-composer"
      data-phase={phase}
      role="group"
      aria-label="Voice message"
    >
      <div className="flex min-h-12 min-w-0 items-center gap-3 px-4 pt-3 pb-1">
        {phase === "error"
          ? (
            <p
              role="alert"
              className="text-destructive flex min-w-0 items-start gap-2 text-sm leading-6"
            >
              <MicOff aria-hidden="true" className="mt-1 size-4 shrink-0" />
              <span>{state.error}</span>
            </p>
          )
          : phase === "review" && take
          ? (
            <div className="grid min-w-0 flex-1 gap-0.5">
              <TakePlayer take={take} />
              {state.limited && (
                <p className="text-muted-foreground text-xs">
                  Recordings stop at {MAX_RECORDING_MS / 60_000} minutes.
                </p>
              )}
            </div>
          )
          : (
            <>
              <span
                aria-hidden="true"
                className={cn(
                  "size-2.5 shrink-0 rounded-full",
                  phase === "starting"
                    ? "bg-muted-foreground/40"
                    : "bg-destructive animate-pulse",
                )}
              />
              <span
                role="timer"
                aria-label="Recording time"
                className="w-10 shrink-0 text-sm font-medium tabular-nums"
              >
                {formatDuration(state.elapsedMs)}
              </span>
              {phase === "starting"
                ? (
                  <span className="text-muted-foreground flex min-w-0 items-center gap-2 text-sm">
                    <Spinner className="size-3.5" /> Starting microphone…
                  </span>
                )
                : (
                  <LiveWaveform
                    levels={state.levels}
                    sampled={state.sampled}
                  />
                )}
            </>
          )}
      </div>
      <div className="flex items-center gap-1 px-2 pb-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="[@media(pointer:coarse)]:size-10"
              aria-label={phase === "error" ? "Close" : "Delete recording"}
              onClick={discard}
            >
              {phase === "error" ? <X /> : <Trash2 />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {phase === "error" ? "Close" : "Delete"}
          </TooltipContent>
        </Tooltip>
        {phase === "review" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="[@media(pointer:coarse)]:size-10"
                aria-label="Record again"
                onClick={onRestart}
              >
                <RotateCcw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Record again</TooltipContent>
          </Tooltip>
        )}
        <div className="flex-1" />
        {live && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                className={round}
                aria-label="Stop recording"
                disabled={phase !== "recording" || sending}
                onClick={() => void recorder.stop()}
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stop and listen back</TooltipContent>
          </Tooltip>
        )}
        {phase === "error"
          ? (
            <Button
              ref={retry}
              type="button"
              variant="secondary"
              size="sm"
              onClick={onRestart}
            >
              <Mic /> Try again
            </Button>
          )
          : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  ref={primary}
                  type="button"
                  size="icon-sm"
                  className={round}
                  aria-label="Send voice message"
                  disabled={disabled || sending || phase === "starting" ||
                    phase === "stopping"}
                  onClick={send}
                >
                  {sending || phase === "stopping"
                    ? <Spinner className="text-primary-foreground" />
                    : <ArrowUp />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Send</TooltipContent>
            </Tooltip>
          )}
      </div>
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </div>
  );
}

/** A take's player, from a local preview of the recording. */
function TakePlayer({ take }: { take: VoiceTake }): React.ReactElement {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const created = URL.createObjectURL(take.file);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [take]);
  return (
    <VoiceNote
      url={url}
      durationMs={take.durationMs}
      peaks={take.peaks}
      label="Your recording"
      className="w-full sm:w-full"
    />
  );
}

type AudioLike = {
  paused: boolean;
  currentTime: number;
  duration: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};
const media = (value: unknown) => value as AudioLike;

/** The voice message playing now: starting another pauses it. */
let playingNow: AudioLike | undefined;

/** `count` bars from peaks, scaled to the loudest: stretched or condensed. */
function resample(peaks: readonly number[], count: number): number[] {
  const top = Math.max(0.05, ...peaks);
  return Array.from({ length: count }, (_, index) => {
    const from = Math.floor(index * peaks.length / count);
    const to = Math.max(
      from + 1,
      Math.floor((index + 1) * peaks.length / count),
    );
    let peak = 0;
    for (let at = from; at < to; at++) peak = Math.max(peak, peaks[at]);
    return Math.max(0.14, Math.min(1, peak / top));
  });
}

const NOTE_BARS = 32;

/** Colors for a voice note on its surface: an own bubble, or anywhere else. */
const TONES = {
  bubble: {
    button:
      "bg-bubble-foreground text-bubble hover:bg-bubble-foreground/90 focus-visible:ring-bubble-foreground/40",
    bar: "bg-bubble-foreground/35",
    played: "bg-bubble-foreground",
    meta:
      "text-bubble-foreground/75 hover:text-bubble-foreground focus-visible:ring-bubble-foreground/40",
    time: "text-bubble-foreground/75",
    quote: "border-bubble-foreground/30",
    focus: "peer-focus-visible:ring-bubble-foreground/40",
  },
  plain: {
    button:
      "bg-foreground text-background hover:bg-foreground/85 focus-visible:ring-ring/45",
    bar: "bg-foreground/20",
    played: "bg-foreground/75",
    meta:
      "text-muted-foreground hover:text-foreground focus-visible:ring-ring/45",
    time: "text-muted-foreground",
    quote: "border-border",
    focus: "peer-focus-visible:ring-ring/45",
  },
} as const;

export interface VoiceNoteProps {
  /** The recording's body; absent while it loads. */
  url?: string;
  /** The body couldn't load; `onRetry` loads it again. */
  failed?: boolean;
  onRetry?(): void;
  durationMs?: number;
  peaks?: readonly number[];
  /** What was said, one click away. */
  transcript?: string;
  /** `bubble` in the person's own message bubble. */
  tone?: keyof typeof TONES;
  /** What the player is called for assistive technology. */
  label?: string;
  className?: string;
}

/**
 * A voice message: play and pause, its waveform as the progress bar (drag or
 * use the arrow keys to seek), its length, and a collapsible transcript.
 */
export function VoiceNote(
  {
    url,
    failed = false,
    onRetry,
    durationMs,
    peaks,
    transcript,
    tone = "plain",
    label = "Voice message",
    className,
  }: VoiceNoteProps,
): React.ReactElement {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [length, setLength] = useState<number>();
  const [open, setOpen] = useState(false);
  const transcriptId = useId();
  const colors = TONES[tone];
  const total = length ?? (durationMs ? durationMs / 1000 : 0);
  const progress = total > 0 ? Math.min(1, position / total) : 0;
  const bars = peaks?.length ? resample(peaks, NOTE_BARS) : undefined;
  const said = transcript?.trim();

  // The waveform fills smoothly while it plays.
  useEffect(() => {
    if (!playing || !scope.requestAnimationFrame) return;
    let frame = 0;
    const tick = () => {
      if (audio.current) setPosition(media(audio.current).currentTime);
      frame = scope.requestAnimationFrame!(tick);
    };
    frame = scope.requestAnimationFrame(tick);
    return () => scope.cancelAnimationFrame?.(frame);
  }, [playing]);

  const toggle = () => {
    if (!audio.current) return;
    const element = media(audio.current);
    if (!element.paused) return element.pause();
    if (playingNow && playingNow !== element) playingNow.pause();
    playingNow = element;
    void element.play().catch(() => setPlaying(false));
  };
  const measured = (element: AudioLike) => {
    if (Number.isFinite(element.duration) && element.duration > 0) {
      setLength(element.duration);
      return true;
    }
    return false;
  };
  const time = playing || position > 0 ? position : total;
  return (
    <div
      data-slot="voice-note"
      role="group"
      aria-label={total ? `${label}, ${formatDuration(total * 1000)}` : label}
      className={cn("grid w-64 max-w-full min-w-0 gap-0.5 sm:w-72", className)}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          onClick={failed ? onRetry : toggle}
          disabled={!url && !failed}
          aria-label={failed
            ? "Couldn't load the voice message. Try again"
            : !url
            ? "Loading the voice message"
            : playing
            ? "Pause"
            : "Play"}
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-[3px] disabled:cursor-default [@media(pointer:coarse)]:size-10",
            colors.button,
          )}
        >
          {failed
            ? <RotateCcw aria-hidden="true" className="size-4" />
            : !url
            ? <Spinner className="size-4 text-current opacity-70" />
            : playing
            ? <Pause aria-hidden="true" className="size-4 fill-current" />
            : (
              <Play
                aria-hidden="true"
                className="size-4 translate-x-px fill-current"
              />
            )}
        </button>
        <div className="relative flex h-9 min-w-0 flex-1 items-center">
          <input
            type="range"
            min={0}
            max={total || 1}
            step="any"
            value={Math.min(position, total || 1)}
            disabled={!url || !total}
            aria-label="Playback position"
            aria-valuetext={`${formatDuration(position * 1000)} of ${
              formatDuration(total * 1000)
            }`}
            onChange={(event) => {
              const value = Number(
                (event.target as unknown as { value: string }).value,
              );
              if (audio.current) media(audio.current).currentTime = value;
              setPosition(value);
            }}
            className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
          />
          {bars
            ? (
              <div
                aria-hidden="true"
                className={cn(
                  "flex h-7 w-full items-center justify-between gap-px rounded-sm",
                  "peer-focus-visible:ring-[3px]",
                  colors.focus,
                )}
              >
                {bars.map((peak, index) => (
                  <span
                    key={index}
                    className={cn(
                      "w-[3px] shrink-0 rounded-full",
                      (index + 0.5) / bars.length <= progress
                        ? colors.played
                        : colors.bar,
                    )}
                    style={{ height: `${Math.round(peak * 100)}%` }}
                  />
                ))}
              </div>
            )
            : (
              <div
                aria-hidden="true"
                className={cn(
                  "h-1 w-full rounded-full peer-focus-visible:ring-[3px]",
                  colors.bar,
                  colors.focus,
                )}
              >
                <div
                  className={cn("h-full rounded-full", colors.played)}
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
            )}
        </div>
        <span
          className={cn(
            "w-9 shrink-0 text-right text-xs tabular-nums",
            colors.time,
          )}
        >
          {total || position ? formatDuration(time * 1000) : ""}
        </span>
      </div>
      {said !== undefined && (
        <div data-slot="voice-transcript" className="min-w-0">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={transcriptId}
            onClick={() =>
              setOpen((value) =>
                !value
              )}
            className={cn(
              "-mx-1 flex h-7 max-w-full min-w-0 items-center gap-1 rounded-md px-1 text-xs transition-colors outline-none focus-visible:ring-[3px]",
              colors.meta,
            )}
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 transition-transform",
                open && "rotate-90",
              )}
            />
            <span className="shrink-0 font-medium">Transcript</span>
            {!open && said && (
              <span aria-hidden="true" className="min-w-0 truncate opacity-80">
                {said.replace(/\s+/g, " ")}
              </span>
            )}
          </button>
          {open && (
            <p
              id={transcriptId}
              className={cn(
                "mt-0.5 mb-1 border-l-2 pl-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap",
                colors.quote,
              )}
            >
              {said || "No speech was detected."}
            </p>
          )}
        </div>
      )}
      {url && (
        <audio
          ref={audio}
          src={url}
          preload="metadata"
          className="hidden"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={(event) => {
            setPlaying(false);
            setPosition(0);
            media(event.currentTarget).currentTime = 0;
          }}
          onTimeUpdate={(event) =>
            setPosition(media(event.currentTarget).currentTime)}
          onDurationChange={(event) =>
            void measured(media(event.currentTarget))}
          onLoadedMetadata={(event) => {
            const element = media(event.currentTarget);
            if (measured(element)) return;
            // Recorded WebM has no length until read through; reading to the
            // end measures it and makes it seekable.
            const settle = () => {
              element.removeEventListener("timeupdate", settle);
              element.currentTime = 0;
              setPosition(0);
              measured(element);
            };
            element.addEventListener("timeupdate", settle);
            element.currentTime = 1e101;
          }}
        />
      )}
    </div>
  );
}
