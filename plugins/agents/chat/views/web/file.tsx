/**
 * A file on a message (kind `file`, its entry on the message with the file's
 * `_id`): an image as a picture, which opens larger; audio as a player
 * (a voice message's with its waveform and what it says); anything else as
 * a chip that downloads it. Its content comes from the web server
 * (`/files/<id>`), as the person reaches it; `hints.mine` when the message
 * is the reader's own.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { size } from "./attach.ts";
import { Download } from "./download.tsx";
import { Picture } from "./picture.tsx";
import { VoiceNote } from "./voice-note.tsx";

type Entry = {
  _id: string;
  name: string;
  type: string;
  size: number;
  voice?: { duration: number; peaks?: number[] };
  transcript?: string;
};

export const fileView = (f: Entry, ctx: ViewContext<ReactNode>): ReactNode => {
  const src = `/files/${encodeURIComponent(f._id)}`;
  if (f.type.startsWith("image/")) {
    return <Picture name={f.name} src={src} type={f.type} size={size(f.size)} />;
  }
  if (f.type.startsWith("audio/")) {
    return (
      <VoiceNote
        src={src}
        name={f.name}
        size={size(f.size)}
        voice={f.voice}
        transcript={f.transcript}
        mine={ctx.hints.mine === true}
      />
    );
  }
  return <Download name={f.name} type={f.type} size={size(f.size)} href={`${src}?download=1`} />;
};
