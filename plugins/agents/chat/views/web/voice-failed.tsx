/**
 * Audio that couldn't be transcribed, so nothing was sent: why, and two
 * ways on: Retry (transcribing again), or Send audio only (without a
 * transcript; agents then can't read what it says). What was recorded or
 * attached stays, to listen to or delete. `busy` while one of them runs.
 */
import type { ReactNode } from "react";
import { Button, Notice } from "../../../../../hosts/web/mod.ts";

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
      title={`Couldn't transcribe ${recorded ? "your recording" : "the audio"}, so it wasn't sent`}
      action={
        <>
          <Button size="sm" variant="ghost" icon="waveform" onClick={onAudioOnly} disabled={busy}>
            Send audio only
          </Button>
          <Button size="sm" icon="retry" onClick={onRetry} disabled={busy}>Retry</Button>
        </>
      }
    >
      {why}
    </Notice>
  );
}
