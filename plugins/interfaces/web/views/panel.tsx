/// <reference lib="dom" />
/**
 * The side panel, for a page that offers it (the `panel` resource): its
 * button at the page's top right, and the panel itself, its View shown only
 * while it's open (`LazyView`). Beside the page on a wide screen, as wide as
 * the person drags it, open or not as they left it (kept in this browser,
 * for them); on a phone, a sheet from the bottom, opened for the page it's
 * on and closed by going elsewhere.
 */
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import {
  Drawer,
  IconButton,
  keep,
  kept,
  LazyView,
  ResizeHandle,
} from "../../../../hosts/web/mod.ts";
import { keysOf, type Panel, toggleLabel, WIDTH, widthOf } from "../shared/panel.ts";

/** What a page shows in its panel: the View, the space it's of, what it's called. */
export type Offered = Panel & { space: string };

/** The panel's state for a person: open on a wide screen (kept), open as a sheet (this page only), its width. */
export function usePanel(viewer: string, path: string, narrow: boolean) {
  const keys = keysOf(viewer);
  const [open, setOpen] = useState(() => kept(keys.open) === "open");
  const [sheet, setSheet] = useState(false);
  const [width, setWidth] = useState(() => widthOf(kept(keys.width)));
  // Going elsewhere closes the sheet; the panel beside the page stays as it was.
  useEffect(() => setSheet(false), [path, narrow]);
  return {
    shown: narrow ? sheet : open,
    width,
    toggle() {
      if (narrow) return setSheet(!sheet);
      setOpen(!open);
      keep(keys.open, open ? "closed" : "open");
    },
    close() {
      if (narrow) return setSheet(false);
      setOpen(false);
      keep(keys.open, "closed");
    },
    resize(next: number) {
      const fit = widthOf(next);
      setWidth(fit);
      keep(keys.width, String(fit));
    },
  };
}

export type PanelState = ReturnType<typeof usePanel>;

/** The button that opens and closes it, at the top right: over the page, or the open panel. */
export function PanelToggle(
  { panel, state, id, narrow }: { panel: Offered; state: PanelState; id: string; narrow: boolean },
): ReactNode {
  return (
    <IconButton
      icon="panel"
      label={toggleLabel(state.shown, panel.title)}
      size={narrow ? "lg" : "md"}
      variant={state.shown && !narrow ? "secondary" : "ghost"}
      className="copilotz-panel-toggle"
      aria-expanded={state.shown}
      aria-controls={id}
      onClick={state.toggle}
    />
  );
}

/** What the panel shows: its View, for the space, compact. */
const content = (panel: Offered) => (
  <LazyView
    kind={panel.view}
    item={{ _id: panel.space }}
    hints={{ in: panel.space, mode: "panel" }}
  />
);

/** Beside the page, on a wide screen: a line to drag it wider, then the panel. */
export function SidePanel(
  { panel, state, id }: { panel: Offered; state: PanelState; id: string },
): ReactNode {
  return (
    <>
      <ResizeHandle
        label="Panel width"
        value={state.width}
        min={WIDTH.min}
        max={WIDTH.max}
        edge="start"
        onChange={state.resize}
        onReset={() => state.resize(WIDTH.start)}
      />
      <aside
        id={id}
        className="copilotz-panel"
        aria-label={panel.title ?? "Panel"}
        // Its header keeps clear of the panel's button, at its top right.
        style={{
          "--copilotz-panel-width": `${state.width}px`,
          "--copilotz-inset-end": "54px",
        } as CSSProperties}
      >
        {content(panel)}
      </aside>
    </>
  );
}

/** On a phone: a sheet from the bottom, with a handle and a way to close it. */
export function PanelSheet(
  { panel, state, id }: { panel: Offered; state: PanelState; id: string },
): ReactNode {
  return (
    <Drawer
      side="bottom"
      open={state.shown}
      onClose={state.close}
      label={panel.title ?? "Panel"}
      className="copilotz-panel-sheet"
    >
      <div className="copilotz-panel-sheet-head">
        <span className="copilotz-panel-grab" aria-hidden="true" />
        <IconButton
          icon="close"
          label="Close"
          className="copilotz-panel-close"
          onClick={state.close}
        />
      </div>
      <div className="copilotz-panel-sheet-body" id={id}>{state.shown ? content(panel) : null}</div>
    </Drawer>
  );
}
