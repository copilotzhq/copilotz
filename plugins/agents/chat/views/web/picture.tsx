/// <reference lib="dom" />
/**
 * An image on a message, from where it's served (`src`): a preview that
 * opens larger, over the page, until Escape or a click. One that won't load
 * shows as its file, to download.
 */
import { type ReactNode, useState } from "react";
import { Dialog, IconButton } from "../../../../../hosts/web/mod.ts";
import { Download } from "./download.tsx";

export function Picture(
  { name, src, type, size }: { name: string; src: string; type: string; size: string },
): ReactNode {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  if (broken) return <Download name={name} type={type} size={size} href={`${src}?download=1`} />;
  return (
    <>
      <button
        type="button"
        className="file-picture"
        aria-label={`Open ${name}`}
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={name} loading="lazy" onError={() => setBroken(true)} />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} label={name} size="auto" bare>
        <figure className="file-view">
          <img src={src} alt={name} />
          <figcaption>
            <span>{name}</span>
            <IconButton
              icon="download"
              label={`Download ${name}`}
              href={`${src}?download=1`}
              download={name}
            />
            <IconButton icon="close" label="Close" onClick={() => setOpen(false)} />
          </figcaption>
        </figure>
      </Dialog>
    </>
  );
}
