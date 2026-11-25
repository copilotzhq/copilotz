/**
 * A space's archived chats, apart, at the end of its Chats tab: a quiet
 * "Archived" row, folded. Unfolded, or while the tab is searched, the archived
 * chats show under it (`chats.archived`), found by the same search; folded and
 * unsearched, nothing of them is read.
 */
import type { ReactNode } from "react";
import { Icon, LazyView, NavItem } from "../../../../../hosts/web/mod.ts";
import { say } from "./words.ts";

export function Shelf(
  { space, compact, search, open, fold }: {
    /** The space whose archived chats these are; none, every space's the person reads. */
    space?: string;
    /** In a side panel: compact rows. */
    compact: boolean;
    /** What the tab is searched for. */
    search: string;
    /** Whether the person unfolded it. */
    open: boolean;
    fold(open: boolean): void;
  },
): ReactNode {
  const id = `shelf-${space ?? "all"}`;
  const searched = search.trim();
  const shown = open || !!searched;
  return (
    <section className="chats-archived" data-open={shown || undefined}>
      <NavItem
        quiet
        onClick={() => fold(!open)}
        leading={<Icon name="archive" size={14} />}
        end={
          <span className="chats-archived-end">
            <Icon name="chevron" size={14} />
          </span>
        }
        aria-expanded={shown}
        aria-controls={shown ? id : undefined}
      >
        {say("archived")}
      </NavItem>
      {shown
        ? (
          <div id={id}>
            <LazyView
              kind="chats.archived"
              item={space ? { _id: space } : {}}
              hints={{
                ...(compact ? { mode: "panel" } : {}),
                ...(searched ? { search: searched } : {}),
              }}
              fallback={null}
            />
          </div>
        )
        : null}
    </section>
  );
}
