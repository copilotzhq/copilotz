/**
 * One item in the palette's list: an option, chosen by the arrows (the
 * field keeps focus, and says which is active) or by a press. Its icon or
 * avatar, its label with what's typed in it marked, a quieter word after
 * it, and at its end what choosing does: a step's chevron, a key, or a
 * spinner while it works.
 */
import type { ReactNode } from "react";
import { Icon } from "../toolkit/icon.tsx";
import { Kbd } from "../toolkit/kbd.tsx";
import { Spinner } from "../toolkit/spinner.tsx";
import { hits } from "./rank.ts";
import type { PaletteItem } from "./state.ts";

/** The label, with what's typed in it marked. */
function Marked({ text, search }: { text: string; search: string }): ReactNode {
  const ranges = hits(search, text);
  if (!ranges.length) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<span key={start} className="copilotz-palette-hit">{text.slice(start, end)}</span>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

export function Row(
  { item, id, active, busy, search, choose, point }: {
    item: PaletteItem;
    id: string;
    active: boolean;
    busy: boolean;
    search: string;
    choose(): void;
    /** The pointer moved over it: it's the active one. */
    point(): void;
  },
): ReactNode {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={item.disabled || undefined}
      aria-busy={busy || undefined}
      className="copilotz-palette-row"
      data-tone={item.tone}
      onPointerMove={active ? undefined : point}
      // The field keeps focus: a press chooses, it doesn't move focus here.
      onMouseDown={(event) => event.preventDefault()}
      onClick={item.disabled ? undefined : choose}
    >
      <span className="copilotz-palette-lead" aria-hidden="true">
        {item.leading ?? <Icon name={item.icon ?? "chevron"} size={16} />}
      </span>
      <span className="copilotz-palette-text">
        <span className="copilotz-palette-label">
          <Marked text={item.label} search={search} />
        </span>
        {item.description
          ? <span className="copilotz-palette-description">{item.description}</span>
          : null}
      </span>
      <span className="copilotz-palette-end" aria-hidden="true">
        {busy
          ? <Spinner size={14} />
          : item.shortcut
          ? <Kbd>{item.shortcut}</Kbd>
          : item.step
          ? <Icon name="chevron" size={15} />
          : active
          ? <Kbd className="copilotz-palette-enter">↵</Kbd>
          : null}
      </span>
    </div>
  );
}
