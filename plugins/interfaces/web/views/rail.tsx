/**
 * The sidebar folded to a rail, on a wide screen: the app's mark (home), the
 * button that unfolds it, Search (the palette), then what sidebar sections
 * offer there (a section's `rail`: a View of the toolkit's `RailItem`s, read
 * only while the rail shows, with the sidebar's hints `{ in, path }`), and
 * the person, with their menu, at its foot. Each item's name shows beside it
 * as a tooltip. Whole or a rail is the person's to choose, kept in this
 * browser (see shared/sidebar.ts); folding or unfolding it from its button
 * keeps focus on the button that takes its place.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { keep, kept, LazyView, Logo, openPalette, RailItem } from "../../../../hosts/web/mod.ts";
import { shortcutOf } from "../shared/palette.ts";
import {
  foldKeyOf,
  foldKeysOf,
  railOf,
  type ShellSettings,
  sidebarKey,
} from "../shared/sidebar.ts";
import { say } from "./words.ts";

/**
 * The sidebar's state for a person: a rail or whole (kept), and folding it.
 * `toggle(true)` puts focus on the button that unfolds or folds it after
 * (`button`, its id), as when it was pressed; otherwise focus stays, unless
 * what had it went with the sidebar it was in.
 */
export function useSidebar(viewer: string, settings: ShellSettings | undefined, button: string) {
  const key = sidebarKey(viewer);
  const [rail, setRail] = useState(() => railOf(kept(key), settings));
  const refocus = useRef(false);
  const was = useRef(rail);
  useEffect(() => {
    if (was.current === rail) return;
    was.current = rail;
    const lost = () => !document.activeElement || document.activeElement === document.body;
    const focus = () => document.getElementById(button)?.focus();
    if (refocus.current || lost()) focus();
    // From the palette: it gives focus back as it closes, to what may have gone.
    else requestAnimationFrame(() => lost() && focus());
    refocus.current = false;
  }, [rail]);
  return {
    rail,
    toggle(focus = false) {
      refocus.current = focus;
      setRail(!rail);
      keep(key, rail ? "full" : "rail");
    },
  };
}

export type SidebarState = ReturnType<typeof useSidebar>;

export function Rail(
  { brand, mac, state, button, sidebar, rails, hints, me }: {
    /** The app's name: its mark goes home. */
    brand: string;
    mac: boolean;
    state: SidebarState;
    /** The id of the button that unfolds it, and of the sidebar it unfolds. */
    button: string;
    sidebar: string;
    /** The Views sections offer for the rail, in their order. */
    rails: string[];
    /** Where the person is, for them: `{ in, path }`. */
    hints: Record<string, unknown>;
    /** The person, and their menu. */
    me: ReactNode;
  },
): ReactNode {
  return (
    <div className="copilotz-rail">
      <div className="copilotz-rail-head">
        <RailItem
          href="/"
          label={say("homeOf", { brand })}
          leading={<Logo size={24} />}
          className="copilotz-rail-mark"
        />
        <RailItem
          id={button}
          icon="sidebar"
          label={say("expandSidebar")}
          shortcut={foldKeyOf(mac)}
          aria-keyshortcuts={foldKeysOf(mac)}
          aria-expanded={false}
          aria-controls={sidebar}
          onClick={() => state.toggle(true)}
        />
        <RailItem
          icon="search"
          label={say("search")}
          shortcut={shortcutOf(mac)}
          onClick={() => openPalette()}
        />
      </div>
      <nav className="copilotz-rail-sections" aria-label={say("spacesAndChats")}>
        {rails.map((view) => (
          <div key={view} className="copilotz-rail-section">
            <LazyView kind={view} hints={hints} fallback={null} />
          </div>
        ))}
      </nav>
      {me}
    </div>
  );
}
