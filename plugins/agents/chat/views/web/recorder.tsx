/**
 * A voice message in the composer, as `record` has it (`state`). While it
 * records: a red dot, the time and how long it may run (how long it has
 * left, in its last minute), the sound as it
 * comes, and Cancel, Stop (to listen back) and Send (at once). Stopped: its
 * player, to listen back, with Record again and Delete. When the
 * microphone didn't start: why, and Try again. `busy` while it's being
 * sent, when nothing changes it. With `focus`, the keyboard follows it: to
 * Stop once recording, to Try again after a failure.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  AudioPlayer,
  Button,
  clock,
  Icon,
  IconButton,
  Spinner,
  Waveform,
} from "../../../../../hosts/web/mod.ts";
import { LIMIT, type Recording } from "./record.ts";
import { say } from "./words.ts";

/** In its last minute, a recording says how long it has left. */
const SOON = 60_000;

export function Recorder(
  { state, busy, focus, onStop, onSend, onDelete, onRestart }: {
    state: Recording;
    busy?: boolean;
    focus?: boolean;
    onStop?(): void;
    onSend?(): void;
    /** Cancel it, delete it, or close why it failed. */
    onDelete(): void;
    /** Record again: a click, so the microphone may start. */
    onRestart(): void;
  },
): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  const { phase } = state;
  useEffect(() => {
    if (!focus) return;
    box.current?.querySelector<HTMLElement>("[data-next]")?.focus();
  }, [focus, phase]);

  if (phase === "error") {
    return (
      <div ref={box} className="voice-error" role="alert">
        <Icon name="mic-off" size={17} />
        <p>{state.error}</p>
        <Button size="sm" icon="mic" onClick={onRestart} data-next>{say("tryAgain")}</Button>
        <IconButton icon="close" size="sm" label={say("close")} onClick={onDelete} />
      </div>
    );
  }

  if (phase === "review" && state.take) {
    return (
      <div ref={box} className="voice-take" role="group" aria-label={say("yourRecording")}>
        <div className="voice-take-row">
          <Take take={state.take} />
          {busy ? null : (
            <span className="voice-take-actions">
              <IconButton icon="retry" size="sm" label={say("recordAgain")} onClick={onRestart} />
              <IconButton
                icon="trash"
                size="sm"
                label={say("deleteRecording")}
                onClick={onDelete}
              />
            </span>
          )}
        </div>
        {state.limited
          ? (
            <p className="voice-take-note">
              {say("recordingsStopAt", { count: LIMIT / 60_000 })}
            </p>
          )
          : null}
      </div>
    );
  }

  const left = LIMIT - state.elapsed;
  const recording = phase === "recording";
  return (
    <div ref={box} className="voice-rec" role="group" aria-label={say("recordingAria")}>
      <div className="voice-rec-meter">
        <span
          className={`voice-rec-dot${recording ? " voice-rec-dot-on" : ""}`}
          aria-hidden="true"
        />
        <span className="voice-rec-time">
          <span role="timer" aria-label={say("recorded")}>{clock(state.elapsed)}</span>
          {left <= SOON
            ? (
              <span className="voice-rec-limit voice-rec-limit-soon">
                <span aria-hidden="true">·</span> {say("timeLeft", { time: clock(left, true) })}
              </span>
            )
            : (
              <span className="voice-rec-limit">
                <span aria-hidden="true">/ {clock(LIMIT)}</span>
                <span className="copilotz-sr">{say("ofMinutes", { count: LIMIT / 60_000 })}</span>
              </span>
            )}
        </span>
        {phase === "starting"
          ? (
            <span className="voice-rec-starting">
              <Spinner size={13} />
              {say("startingMic")}
            </span>
          )
          : <Waveform live peaks={state.levels} className="voice-rec-wave" />}
      </div>
      <div className="voice-rec-actions">
        <Button variant="ghost" size="sm" icon="trash" onClick={onDelete}>{say("cancel")}</Button>
        <span className="voice-rec-end">
          <Button
            size="sm"
            className="voice-rec-stop"
            onClick={onStop}
            disabled={!recording}
            data-next
          >
            <Icon name="stop" size={11} filled />
            {say("stop")}
          </Button>
          <IconButton
            icon="send"
            label={say("sendNow")}
            variant="primary"
            className="chat-send"
            onClick={onSend}
            disabled={!recording}
            loading={phase === "stopping"}
          />
        </span>
      </div>
      <p className="copilotz-sr" aria-live="polite">
        {phase === "starting" ? say("startingMicSr") : say("recordingSr")}
      </p>
    </div>
  );
}

/** A take's player, from the recording in memory (an object URL, let go after). */
function Take({ take }: { take: NonNullable<Recording["take"]> }): ReactNode {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const made = URL.createObjectURL(take.blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [take.blob]);
  return (
    <AudioPlayer
      variant="bare"
      src={url}
      duration={take.duration}
      peaks={take.peaks}
      label={say("yourRecording")}
      className="voice-take-player"
    />
  );
}
