/**
 * The gallery's sound: the toolkit's `AudioPlayer` on each surface and its
 * `Waveform` (to seek, and live), then chat's voice messages: the
 * composer's recorder in each of its states, sending (transcribing) and
 * failing to, and a voice message as a conversation shows it. A hum made
 * here stands in for a recording.
 */
import { type ReactNode, useState } from "react";
import { AudioPlayer, Spinner, Waveform } from "../../hosts/web/mod.ts";
import { LIMIT, type Recording } from "../../plugins/agents/chat/views/web/record.ts";
import { Recorder } from "../../plugins/agents/chat/views/web/recorder.tsx";
import { STYLE } from "../../plugins/agents/chat/views/web/style.ts";
import { VoiceFailed } from "../../plugins/agents/chat/views/web/voice-failed.tsx";
import { VoiceNote } from "../../plugins/agents/chat/views/web/voice-note.tsx";
import { hum } from "./hum.ts";

const LOCAL = `
.gallery-voice { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 14px;
  align-items: start; }
.gallery-voice-label { margin: 0 0 6px; color: var(--muted-foreground); font: 11.5px var(--font-mono); }
.gallery-composers { display: grid; gap: 18px; max-width: 720px; }
.gallery-composers .chat-box { box-shadow: var(--shadow-sm); }
.gallery-thread { display: grid; gap: 4px; max-width: 720px; padding: 18px 20px; border: 1px dashed var(--input);
  border-radius: var(--radius-xl); }
`;

/** Levels as a recording's live waveform has them, after a few seconds of talk. */
const LEVELS = Array.from(
  { length: 120 },
  (_, i) =>
    Math.max(0, Math.sin(i / 3.1) * 0.35 + Math.sin(i / 1.3) * 0.25 + 0.3) * (i % 23 < 4 ? 0.1 : 1),
);

const LONG =
  "Hi both, a quick update from the train. The venue moved the launch dinner to Thursday " +
  "at seven, so the rehearsal is Wednesday afternoon instead. Bob, can you check the projector " +
  "works with the new laptops? Ana, the menu needs a vegetarian main; the venue suggested the " +
  "risotto. I'll be back online after six.";

export function VoiceGallery(): ReactNode {
  const [sample] = useState(() => hum(6.4));
  const [seek, setSeek] = useState(0.35);
  const take = {
    blob: sample.blob,
    type: "audio/wav",
    name: "voice-message.wav",
    duration: 6400,
    peaks: sample.peaks,
  };
  const states: [string, Recording][] = [
    ["starting", { phase: "starting", elapsed: 0, levels: [] }],
    ["recording", { phase: "recording", elapsed: 7_400, levels: LEVELS.slice(-70) }],
    ["in its last minute", { phase: "recording", elapsed: LIMIT - 42_000, levels: LEVELS }],
    ["review", { phase: "review", elapsed: 6400, levels: LEVELS, take }],
    ["review, at the limit", {
      phase: "review",
      elapsed: LIMIT,
      levels: LEVELS,
      take,
      limited: true,
    }],
    ["the microphone refused", {
      phase: "error",
      elapsed: 0,
      levels: [],
      error:
        "Microphone access is blocked. Allow it for this site in your browser's settings, then try again.",
      denied: true,
    }],
  ];
  const nothing = () => {};
  return (
    <>
      <style href="chat-web" precedence="copilotz">{STYLE}</style>
      <style href="gallery-voice" precedence="copilotz">{LOCAL}</style>

      <div className="gallery-voice">
        {(["card", "muted", "bubble"] as const).map((variant) => (
          <div key={variant}>
            <p className="gallery-voice-label">variant="{variant}"</p>
            <AudioPlayer
              src={sample.url}
              duration={6400}
              peaks={sample.peaks}
              label="Voice message"
              variant={variant}
            />
          </div>
        ))}
        <div>
          <p className="gallery-voice-label">no peaks: a flat waveform</p>
          <AudioPlayer src={sample.url} label="interview.wav" />
        </div>
        <div>
          <p className="gallery-voice-label">loading (no src yet)</p>
          <AudioPlayer duration={6400} peaks={sample.peaks} label="Voice message" />
        </div>
        <div>
          <p className="gallery-voice-label">couldn't load</p>
          <AudioPlayer
            src="/files/missing"
            duration={3000}
            peaks={sample.peaks}
            label="Voice message"
          />
        </div>
      </div>

      <div className="gallery-voice" style={{ marginTop: 14 }}>
        <div>
          <p className="gallery-voice-label">Waveform onSeek: click, drag, arrows</p>
          <Waveform
            peaks={sample.peaks}
            progress={seek}
            onSeek={setSeek}
            label="Position"
            valueText={`${Math.round(seek * 100)}%`}
          />
        </div>
        <div>
          <p className="gallery-voice-label">Waveform live</p>
          <Waveform live peaks={LEVELS.slice(-50)} bars={80} />
        </div>
      </div>

      <h3 className="gallery-title" style={{ marginTop: 26 }}>Recording, in the composer</h3>
      <div className="gallery-composers">
        {states.map(([label, state]) => (
          <div key={label}>
            <p className="gallery-voice-label">{label}</p>
            <div className="chat-box">
              <Recorder
                state={state}
                onStop={nothing}
                onSend={nothing}
                onDelete={nothing}
                onRestart={nothing}
              />
              {state.phase === "review" || state.phase === "error"
                ? (
                  <p className="chat-input" style={{ margin: 0, color: "var(--muted-foreground)" }}>
                    Add a message, or just send it
                  </p>
                )
                : null}
            </div>
          </div>
        ))}
        <div>
          <p className="gallery-voice-label">sending: transcribing</p>
          <div className="chat-status" role="status">
            <Spinner size={13} className="chat-status-spin" />
            <span className="chat-status-text">Transcribing your recording…</span>
          </div>
          <div className="chat-box">
            <Recorder
              state={{ phase: "review", elapsed: 6400, levels: LEVELS, take }}
              busy
              onDelete={nothing}
              onRestart={nothing}
            />
            <p className="chat-input" style={{ margin: 0 }}>Here's the plan for Thursday</p>
          </div>
        </div>
        <div>
          <p className="gallery-voice-label">transcribing failed: nothing was sent</p>
          <VoiceFailed
            why="The transcription service didn't answer in time."
            recorded
            onRetry={nothing}
            onAudioOnly={nothing}
          />
          <div className="chat-box">
            <Recorder
              state={{ phase: "review", elapsed: 6400, levels: LEVELS, take }}
              onDelete={nothing}
              onRestart={nothing}
            />
            <p className="chat-input" style={{ margin: 0, color: "var(--muted-foreground)" }}>
              Add a message, or just send it
            </p>
          </div>
        </div>
      </div>

      <h3 className="gallery-title" style={{ marginTop: 26 }}>Voice messages, in a conversation</h3>
      <div className="gallery-thread">
        <article className="msg msg-mine">
          <div className="msg-main">
            <div className="msg-files">
              <VoiceNote
                src={sample.url}
                name="voice-message.webm"
                size="25 KB"
                voice={{ duration: 6400, peaks: sample.peaks }}
                transcript="Can you move the review to Thursday morning?"
                mine
              />
            </div>
          </div>
        </article>
        <article className="msg msg-person">
          <div className="msg-gutter" />
          <div className="msg-main">
            <header className="msg-head">
              <span className="msg-name">bob</span>
            </header>
            <div className="msg-files">
              <VoiceNote
                src={sample.url}
                name="voice-message.m4a"
                size="88 KB"
                voice={{ duration: 41_000, peaks: [...sample.peaks].reverse() }}
                transcript={LONG}
              />
            </div>
          </div>
        </article>
        <article className="msg msg-mine">
          <div className="msg-main">
            <div className="msg-files">
              <VoiceNote
                src={sample.url}
                name="voice-message.webm"
                size="25 KB"
                voice={{ duration: 6400, peaks: sample.peaks }}
                mine
              />
            </div>
          </div>
        </article>
        <article className="msg msg-person">
          <div className="msg-gutter" />
          <div className="msg-main">
            <header className="msg-head">
              <span className="msg-name">ana</span>
            </header>
            <div className="msg-files">
              <VoiceNote
                src={sample.url}
                name="interview-take-2.wav"
                size="1.2 MB"
                transcript="So the first thing we looked at was the onboarding."
              />
            </div>
          </div>
        </article>
      </div>
    </>
  );
}
