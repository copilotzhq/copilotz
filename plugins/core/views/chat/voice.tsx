/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** Voice compose: record, review and send an audio message. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Mic, RotateCcw, Square, Trash2 } from "lucide-react";
import {
  Button,
  cn,
  formatDuration,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@copilotz/copilotz/web/kit";

type Recorder = {
  stop(): void;
  cancel(): void;
};

type Stream = { getTracks(): { stop(): void }[] };
type Media = {
  mediaDevices?: {
    getUserMedia(constraints: { audio: boolean }): Promise<Stream>;
  };
};
type MediaRecorderLike = {
  state: string;
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
};
type AudioContextLike = {
  createAnalyser(): {
    fftSize: number;
    frequencyBinCount: number;
    getByteTimeDomainData(data: Uint8Array): void;
  };
  createMediaStreamSource(stream: Stream): { connect(node: unknown): void };
  close(): Promise<void>;
};
type Globals = {
  navigator?: Media;
  MediaRecorder?: new (stream: Stream) => MediaRecorderLike;
  AudioContext?: new () => AudioContextLike;
  requestAnimationFrame?(callback: () => void): number;
  cancelAnimationFrame?(handle: number): void;
};
const scope = globalThis as unknown as Globals;

/** Whether this browser can record audio for a voice message. */
export function canRecordVoice(): boolean {
  return Boolean(
    scope.navigator?.mediaDevices?.getUserMedia && scope.MediaRecorder,
  );
}

function start(
  onLevel: (level: number) => void,
  onStopped: (file: File) => void,
  onError: (message: string) => void,
): Recorder {
  let cancelled = false;
  let recorder: MediaRecorderLike | undefined;
  let stream: Stream | undefined;
  let context: AudioContextLike | undefined;
  let frame = 0;
  const chunks: Blob[] = [];
  const release = () => {
    scope.cancelAnimationFrame?.(frame);
    stream?.getTracks().forEach((track) => track.stop());
    void context?.close().catch(() => {});
  };
  scope.navigator!.mediaDevices!.getUserMedia({
    audio: true,
  }).then((media) => {
    if (cancelled) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = media;
    recorder = new scope.MediaRecorder!(media);
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      release();
      if (cancelled) return;
      const type = recorder?.mimeType || "audio/webm";
      const extension = type.includes("mp4") ? "m4a" : "webm";
      onStopped(
        new File(chunks, `voice-message.${extension}`, { type }),
      );
    };
    recorder.start();
    try {
      context = new scope.AudioContext!();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(media).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
        onLevel(Math.min(1, peak / 64));
        frame = scope.requestAnimationFrame?.(tick) ?? 0;
      };
      tick();
    } catch { /* Level metering is optional. */ }
  }, (error: unknown) => {
    release();
    onError(
      error instanceof DOMException && error.name === "NotAllowedError"
        ? "Microphone access was denied. Allow it in your browser settings."
        : "The microphone couldn't start.",
    );
  });
  return {
    stop() {
      if (recorder?.state === "recording") recorder.stop();
    },
    cancel() {
      cancelled = true;
      if (recorder?.state === "recording") recorder.stop();
      else release();
    },
  };
}

/**
 * Replaces the text field while recording: a live level meter and timer,
 * then a review step with playback, Send, Record again and Discard.
 */
export function VoiceComposer(
  { onSend, onClose, disabled = false }: {
    onSend(file: File): void;
    onClose(): void;
    disabled?: boolean;
  },
): React.ReactElement {
  const [state, setState] = useState<
    "starting" | "recording" | "review" | "error"
  >("starting");
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string>();
  const recorder = useRef<Recorder | null>(null);
  const began = useRef(0);

  const record = () => {
    setFile(null);
    setError("");
    setElapsed(0);
    setState("starting");
    began.current = Date.now();
    recorder.current = start(
      (value) => {
        setLevel(value);
        setState((current) => current === "starting" ? "recording" : current);
      },
      (recorded) => {
        setFile(recorded);
        setState("review");
      },
      (message) => {
        setError(message);
        setState("error");
      },
    );
  };

  useEffect(() => {
    record();
    return () => recorder.current?.cancel();
  }, []);
  useEffect(() => {
    if (state !== "recording" && state !== "starting") return;
    const timer = setInterval(
      () => setElapsed(Date.now() - began.current),
      200,
    );
    return () => clearInterval(timer);
  }, [state]);
  useEffect(() => {
    if (!file) return setUrl(undefined);
    const created = URL.createObjectURL(file);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [file]);

  const bars = Array.from({ length: 24 }, (_, index) => {
    const wave = Math.abs(Math.sin((index + elapsed / 120) * 0.9));
    return Math.max(0.12, level * (0.35 + 0.65 * wave));
  });

  return (
    <div
      data-slot="voice-composer"
      role="group"
      aria-label="Voice message"
      className="flex min-h-11 items-center gap-2 px-1"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Discard voice message"
            onClick={() => {
              recorder.current?.cancel();
              onClose();
            }}
          >
            <Trash2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Discard</TooltipContent>
      </Tooltip>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {state === "review" && url
          ? <audio src={url} controls className="h-9 w-full max-w-sm" />
          : state === "error"
          ? <p role="alert" className="text-destructive text-sm">{error}</p>
          : (
            <>
              <span
                aria-hidden="true"
                className={cn(
                  "size-2.5 shrink-0 rounded-full bg-destructive",
                  state === "recording" && "animate-pulse",
                )}
              />
              <span
                role="timer"
                aria-label="Recording time"
                className="text-sm tabular-nums"
              >
                {formatDuration(elapsed)}
              </span>
              <span
                aria-hidden="true"
                className="flex h-6 min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
              >
                {bars.map((height, index) => (
                  <span
                    key={index}
                    className="bg-foreground/60 w-1 shrink-0 rounded-full transition-[height] duration-100"
                    style={{ height: `${Math.round(height * 100)}%` }}
                  />
                ))}
              </span>
              {state === "starting" && (
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Spinner className="size-3" /> Starting microphone…
                </span>
              )}
            </>
          )}
      </div>
      {state === "review" || state === "error"
        ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Record again"
                  onClick={record}
                >
                  {state === "error" ? <Mic /> : <RotateCcw />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Record again</TooltipContent>
            </Tooltip>
            <Button
              type="button"
              size="icon-sm"
              className="rounded-full"
              aria-label="Send voice message"
              disabled={!file || disabled}
              onClick={() => file && onSend(file)}
            >
              <ArrowUp />
            </Button>
          </>
        )
        : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                className="rounded-full"
                aria-label="Stop recording"
                onClick={() => recorder.current?.stop()}
              >
                <Square className="fill-current" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stop and review</TooltipContent>
          </Tooltip>
        )}
    </div>
  );
}
