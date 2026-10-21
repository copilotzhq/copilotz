/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/**
 * The conversation log: a virtualized column that stays pinned to the newest
 * message, keeps the reader's place when older messages load above, and
 * offers a jump back to the latest.
 * @module
 */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import {
  Button,
  cn,
  dom,
  nextFrame,
  Spinner,
} from "@copilotz/copilotz/web/kit";

/** One row: a stable key (a group's last message id) and its content. */
export type LogItem = Readonly<{
  key: string;
  node: React.ReactNode;
  /** No spacing above (a row that may render nothing, like the live tail). */
  bare?: boolean;
}>;

/** Where the anchor row must land after rows are prepended above it. */
export function prependScrollTop(
  anchor: Readonly<{ start: number; offset: number }>,
  listOffset = 0,
): number {
  return Math.max(0, listOffset + anchor.start - anchor.offset);
}

const useIsomorphicLayoutEffect =
  typeof (globalThis as { document?: unknown }).document === "undefined"
    ? useEffect
    : useLayoutEffect;

export function MessageLog(
  {
    items,
    empty,
    busy = false,
    hasOlder = false,
    loadingOlder = false,
    onLoadOlder,
    label = "Messages",
    resetKey,
  }: {
    items: readonly LogItem[];
    /** Shown instead of the log when there are no rows. */
    empty?: React.ReactNode;
    /** A reply is in progress (`aria-busy`). */
    busy?: boolean;
    hasOlder?: boolean;
    loadingOlder?: boolean;
    onLoadOlder?(): void;
    label?: string;
    /** Changing it (another thread) jumps to the newest message again. */
    resetKey?: string;
  },
): React.ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const anchor = useRef<{ key: string; offset: number; count: number } | null>(
    null,
  );
  const lastCount = useRef(items.length);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    // A prepended fragment can merge into the old first group; its last
    // message survives, so keying by it keeps the measured height.
    getItemKey: (index) => items[index]?.key ?? index,
    estimateSize: () => 140,
    overscan: 6,
    initialRect: { width: 800, height: 900 },
  });

  const toBottom = useCallback((smooth = false) => {
    if (!scroller.current) return;
    const element = dom(scroller.current);
    if (smooth && element.scrollTo) {
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    } else element.scrollTop = element.scrollHeight;
  }, []);

  useEffect(() => {
    pinned.current = true;
    anchor.current = null;
    setUnseen(false);
    setAtBottom(true);
    nextFrame(() => toBottom());
  }, [resetKey, toBottom]);

  // Keep the newest message in view while pinned, including while it streams.
  useIsomorphicLayoutEffect(() => {
    if (!scroller.current) return;
    const element = dom(scroller.current);
    const saved = anchor.current;
    if (saved && items.length > saved.count) {
      const index = items.findIndex((item) => item.key === saved.key);
      if (index >= 0) {
        const start = virtualizer.getOffsetForIndex(index, "start")?.[0];
        if (start !== undefined) {
          element.scrollTop = prependScrollTop({
            start,
            offset: saved.offset,
          }, list.current ? dom(list.current).offsetTop : 0);
        }
      }
      anchor.current = null;
    } else if (pinned.current) {
      toBottom();
    } else if (items.length > lastCount.current) {
      setUnseen(true);
    }
    lastCount.current = items.length;
  });

  const onScroll = () => {
    if (!scroller.current) return;
    const element = dom(scroller.current);
    const top = list.current ? dom(list.current).offsetTop : 0;
    const bottom = element.scrollHeight - element.scrollTop -
        element.clientHeight < 80;
    pinned.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
    if (bottom && unseen) setUnseen(false);
    if (
      element.scrollTop < 240 && hasOlder && !loadingOlder && onLoadOlder &&
      !anchor.current && items.length
    ) {
      const first = virtualizer.getVirtualItems().find((item) =>
        item.end > element.scrollTop - top
      );
      if (first) {
        anchor.current = {
          key: items[first.index].key,
          offset: top + first.start - element.scrollTop,
          count: items.length,
        };
      }
      onLoadOlder();
    }
  };

  const rows = virtualizer.getVirtualItems();
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        role="log"
        aria-label={label}
        aria-busy={busy || undefined}
        tabIndex={0}
        onScroll={onScroll}
        className="h-full overflow-y-auto overscroll-contain outline-none [overflow-anchor:none]"
      >
        {items.length === 0
          ? empty
          : (
            <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-8 sm:px-6">
              {(hasOlder || loadingOlder) && (
                <div className="flex justify-center pb-4">
                  {loadingOlder
                    ? (
                      <span className="text-muted-foreground flex items-center gap-2 text-xs">
                        <Spinner className="size-3" /> Loading older messages…
                      </span>
                    )
                    : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="text-muted-foreground"
                        onClick={() => onLoadOlder?.()}
                      >
                        Load older messages
                      </Button>
                    )}
                </div>
              )}
              <div
                ref={list}
                className="relative w-full"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {rows.map((row) => (
                  <div
                    key={row.key}
                    data-index={row.index}
                    ref={virtualizer.measureElement}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${row.start}px)` }}
                  >
                    <div
                      className={row.index === 0 || items[row.index].bare
                        ? ""
                        : "pt-6"}
                    >
                      {items[row.index].node}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
      </div>
      {!atBottom && items.length > 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Jump to the latest message"
          onClick={() => {
            pinned.current = true;
            setUnseen(false);
            toBottom(true);
          }}
          className={cn(
            "bg-background/95 absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-float backdrop-blur",
            unseen && "border-primary/40",
          )}
        >
          <ArrowDown />
          {unseen ? "New messages" : "Latest"}
        </Button>
      )}
    </div>
  );
}
