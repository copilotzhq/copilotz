/**
 * A voice message, or audio sent with a message: its player (in the
 * reader's bubble when it's theirs, muted when it's someone else's) and,
 * beneath it, what it says: open when it's short, "Show transcript" when
 * it's long. Audio that isn't a recording made here (no `voice`) has a
 * flat waveform, its name and a download. Sent as audio only, there's no
 * transcript.
 */
import { type ReactNode, useId, useState } from "react";
import { AudioPlayer, Icon, IconButton } from "../../../../../hosts/web/mod.ts";
import { say } from "./words.ts";

/** Transcripts up to this long show open. */
const SHORT = 180;

export function VoiceNote(
  { src, name, size, voice, transcript, mine }: {
    src: string;
    name: string;
    size: string;
    voice?: { duration: number; peaks?: number[] };
    transcript?: string;
    mine?: boolean;
  },
): ReactNode {
  const said = transcript?.trim();
  const [open, setOpen] = useState(() => (said ?? "").length <= SHORT);
  const id = useId();
  return (
    <AudioPlayer
      src={src}
      duration={voice?.duration}
      peaks={voice?.peaks}
      label={voice ? say("voiceMessage") : name}
      variant={mine ? "bubble" : "muted"}
      className="voice-note"
    >
      {voice ? null : (
        <span className="voice-note-file">
          <span>{name}</span>
          <small>{size}</small>
          <IconButton
            icon="download"
            size="sm"
            label={say("download", { name })}
            href={`${src}?download=1`}
            download={name}
          />
        </span>
      )}
      {said === undefined ? null : (
        <div className="voice-said">
          <button
            type="button"
            className="voice-said-toggle"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(!open)}
          >
            <Icon name="chevron" size={13} />
            {open ? say("transcript") : say("showTranscript")}
          </button>
          <p id={id} className="voice-said-text" hidden={!open}>
            {said || say("noSpeech")}
          </p>
        </div>
      )}
    </AudioPlayer>
  );
}
