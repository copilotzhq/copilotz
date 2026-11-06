/**
 * Audio that couldn't be transcribed, so nothing was sent: why, and two
 * ways on: Retry (transcribing again), or Send audio only (without a
 * transcript; agents then can't read what it says). What was recorded or
 * attached stays, to listen to or delete. `busy` while one of them runs.
 */
import type { ReactNode } from "react";
import { Button, Notice } from "../../../../../hosts/web/mod.ts";
import { say } from "./words.ts";

export function VoiceFailed(
  { why, recorded, busy, onRetry, onAudioOnly }: {
    why: string;
    /** It's a recording made here, not a file attached. */
    recorded?: boolean;
    busy?: boolean;
    onRetry(): void;
    onAudioOnly(): void;
  },
): ReactNode {
  return (
    <Notice
      tone="destructive"
      role="alert"
      className="voice-failed"
      title={say(recorded ? "couldntTranscribeRecording" : "couldntTranscribeAudio")}
      action={
        <>
          <Button size="sm" variant="ghost" icon="waveform" onClick={onAudioOnly} disabled={busy}>
            {say("sendAudioOnly")}
          </Button>
          <Button size="sm" icon="retry" onClick={onRetry} disabled={busy}>{say("retry")}</Button>
        </>
      }
    >
      {why}
    </Notice>
  );
}
