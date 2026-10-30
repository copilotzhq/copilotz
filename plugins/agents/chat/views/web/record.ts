/**
 * Recording a voice message, started from the click that asks to (some
 * browsers, Safari among them, let sound start only from one). It asks for
 * the microphone then, records in the best format the browser has (Opus in
 * WebM, else AAC in MP4, else its own), measures the sound every 50 ms for
 * the live waveform, stops itself at `LIMIT`, and lets the microphone go
 * when it stops, so the browser's indicator goes off. Stopped, it's a
 * take: the audio, how long it ran (ms) and its peaks. Observed as React's
 * external stores are (`subscribe`, `get`).
 *
 * ```ts
 * const recorder = record(); // in a click
 * const take = await recorder.stop();
 * ```
 */
import { resample } from "../../../../../hosts/web/mod.ts";

/** A finished recording, ready to send. */
export type Take = {
  blob: Blob;
  /** Its media type, without codecs: `audio/webm`, `audio/mp4`. */
  type: string;
  name: string;
  /** How long it runs, ms. */
  duration: number;
  /** Its loudness over time, 0 to 1: `PEAKS` of them, or none when it couldn't be measured. */
  peaks: number[];
};

/** Where a recording is. */
export type Recording = {
  phase: "starting" | "recording" | "stopping" | "review" | "error";
  /** How long it has run, ms. */
  elapsed: number;
  /** The latest levels (0 to 1), oldest first: the live waveform. */
  levels: number[];
  take?: Take;
  /** Why it didn't start, or stopped. */
  error?: string;
  /** The microphone was refused: the browser's settings let it again. */
  denied?: boolean;
  /** It stopped at `LIMIT`. */
  limited?: boolean;
};

export type Recorder = {
  subscribe(listener: () => void): () => void;
  get(): Recording;
  /** Stops and keeps it; nothing when there was nothing to keep. */
  stop(): Promise<Take | undefined>;
  /** Stops and drops it. */
  cancel(): void;
};

/** The longest a voice message runs: ten minutes. */
export const LIMIT = 10 * 60_000;
/** The formats asked for, best first; without one, the browser's own. */
const FORMATS = ["audio/webm;codecs=opus", "audio/mp4"];
/** How often the sound is measured, ms. */
const EVERY = 50;
/** Levels kept for the live waveform: enough for a wide composer. */
const LIVE = 120;
/** How many peaks a take has. */
const PEAKS = 64;
/** Shorter than this, there's nothing to send. */
const SHORTEST = 500;

/** Plain words for why the microphone didn't start. */
const why = (error: unknown): Pick<Recording, "error" | "denied"> => {
  const name = (error as { name?: string } | undefined)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      error:
        "Microphone access is blocked. Allow it for this site in your browser's settings, then try again.",
      denied: true,
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return { error: "No microphone was found. Connect one, then try again." };
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return { error: "The microphone is busy in another app. Close it there, then try again." };
  }
  return { error: "The microphone couldn't start." };
};

const extension = (type: string) =>
  type.includes("webm")
    ? "webm"
    : type.includes("ogg")
    ? "ogg"
    : type.includes("mp4")
    ? "m4a"
    : "audio";

export function record(limit = LIMIT): Recorder {
  const listeners = new Set<() => void>();
  let now: Recording = { phase: "starting", elapsed: 0, levels: [] };
  const set = (patch: Partial<Recording>) => {
    now = { ...now, ...patch };
    for (const listener of listeners) listener();
  };

  const levels: number[] = [];
  const chunks: Blob[] = [];
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = 0;
  let stoppedAt = 0;
  let cancelled = false;
  let settle: (take: Take | undefined) => void = () => {};
  const done = new Promise<Take | undefined>((resolve) => (settle = resolve));

  // The meter's audio starts here, inside the click: Safari keeps it suspended otherwise.
  let context: AudioContext | undefined;
  try {
    const Context = globalThis.AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    context = Context ? new Context() : undefined;
    void context?.resume().catch(() => {});
  } catch {
    context = undefined; // The waveform is a nicety; the recording isn't.
  }

  const release = () => {
    clearInterval(timer);
    timer = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    void context?.close().catch(() => {});
    context = undefined;
  };
  const fail = (patch: Pick<Recording, "error" | "denied">) => {
    release();
    set({ phase: "error", ...patch });
    settle(undefined);
  };

  const finish = (format?: string) => {
    const duration = Math.round((stoppedAt || performance.now()) - started);
    release();
    if (cancelled) return settle(undefined);
    const type = (recorder?.mimeType || format || "audio/webm").split(";")[0].trim();
    const blob = new Blob(chunks, { type });
    if (!blob.size || duration < SHORTEST) {
      set({ phase: "error", error: "That was too short to send. Hold on a moment longer." });
      return settle(undefined);
    }
    const take: Take = {
      blob,
      type,
      name: `voice-message.${extension(type)}`,
      duration,
      peaks: levels.some((level) => level > 0) ? resample(levels, PEAKS) : [],
    };
    set({ phase: "review", elapsed: duration, take });
    settle(take);
  };

  const begin = (granted: MediaStream) => {
    if (cancelled) return granted.getTracks().forEach((track) => track.stop());
    stream = granted;
    const format = FORMATS.find((type) => {
      try {
        return MediaRecorder.isTypeSupported(type);
      } catch {
        return false;
      }
    });
    try {
      recorder = new MediaRecorder(granted, format ? { mimeType: format } : undefined);
    } catch {
      return fail({ error: "This browser can't record audio." });
    }
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    recorder.onerror = () => {
      if (!cancelled) fail({ error: "The recording stopped unexpectedly. Try again." });
    };
    recorder.onstop = () => finish(format);
    try {
      recorder.start();
    } catch {
      return fail({ error: "The microphone couldn't start." });
    }
    started = performance.now();
    set({ phase: "recording" });

    let analyser: AnalyserNode | undefined;
    let data: Uint8Array<ArrayBuffer> | undefined;
    try {
      if (context) {
        analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(granted).connect(analyser);
        // Pulled through to a silent output: some Safari versions measure nothing otherwise.
        const silent = context.createGain();
        silent.gain.value = 0;
        analyser.connect(silent);
        silent.connect(context.destination);
        data = new Uint8Array(analyser.fftSize);
      }
    } catch {
      analyser = undefined;
    }
    timer = setInterval(() => {
      const elapsed = performance.now() - started;
      let level = 0;
      if (analyser && data) {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) sum += ((value - 128) / 128) ** 2;
        // Loudness, eased so quiet speech still moves the bars.
        level = Math.min(1, Math.sqrt(Math.sqrt(sum / data.length)) * 1.6);
      }
      levels.push(level);
      set({ elapsed, levels: levels.slice(-LIVE) });
      if (elapsed >= limit) {
        set({ limited: true });
        void stop();
      }
    }, EVERY);
  };

  const stop = (): Promise<Take | undefined> => {
    if (recorder?.state === "recording") {
      stoppedAt = performance.now();
      clearInterval(timer);
      set({ phase: "stopping" });
      recorder.stop();
    } else if (now.phase === "starting") cancel();
    return done;
  };
  // The microphone goes off at once; the recorder's own stop follows, and keeps nothing.
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    const active = recorder?.state === "recording";
    release();
    if (active) recorder?.stop();
    else settle(undefined);
  };

  const media = globalThis.navigator?.mediaDevices;
  if (!media?.getUserMedia || typeof MediaRecorder === "undefined") {
    fail({ error: "This browser can't record audio here." });
  } else {
    media.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }).then(begin, (error) => {
      if (!cancelled) fail(why(error));
    });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => now,
    stop,
    cancel,
  };
}
