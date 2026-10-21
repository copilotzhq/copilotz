/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** The right panel: beside main from `lg`, overlaying it below, resizable at every width. @module */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { browser, cn, dom, domEvent } from "@copilotz/copilotz/web/kit";
import { clampPanelWidth } from "../model.ts";

/** Main keeps at least this much room beside the panel. */
const MAIN_MIN = 360;

export function ResizablePanel(
  { width, onResize, label, children, className }: {
    /** The reader's width; clamped to the room available. */
    width: number;
    /** Commit a width (on release or a key press). */
    onResize(width: number): void;
    label: string;
    children?: React.ReactNode;
    className?: string;
  },
): React.ReactElement {
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const parent = panel.current ? dom(panel.current).parentElement : null;
    if (!parent) return;
    const measure = () => {
      // Overlaying (below lg) the panel may use the whole area; beside main
      // it leaves main its minimum. The stylesheet decides which applies.
      const overlay = panel.current &&
        browser.getComputedStyle?.(panel.current).position === "absolute";
      setRoom(parent.clientWidth - (overlay ? 0 : MAIN_MIN));
    };
    measure();
    if (!browser.ResizeObserver) return;
    const observer = new browser.ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  const bound = (value: number) =>
    room > 0 ? clampPanelWidth(value, room) : Math.round(value);
  const shown = bound(live ?? width);
  const finish = () => {
    if (!drag.current) return;
    drag.current = null;
    if (live !== null) onResize(bound(live));
    setLive(null);
  };
  return (
    <aside
      ref={panel}
      aria-label={label}
      data-slot="side-panel"
      style={{ width: shown }}
      className={cn(
        "bg-background absolute inset-y-0 right-0 z-30 flex max-w-full min-w-0 shrink-0 flex-col border-l shadow-float lg:relative lg:z-auto lg:shadow-none",
        live !== null && "select-none",
        className,
      )}
    >
      <div
        role="separator"
        aria-label={`Resize ${label.toLowerCase()}`}
        aria-orientation="vertical"
        aria-valuemin={280}
        aria-valuemax={Math.max(280, Math.round(room))}
        aria-valuenow={shown}
        tabIndex={0}
        className="group/handle focus-visible:ring-ring/45 absolute inset-y-0 -left-1.5 z-20 flex w-3 cursor-col-resize touch-none items-center justify-center outline-none focus-visible:ring-[3px]"
        onPointerDown={(event) => {
          if (domEvent(event).button !== 0) return;
          event.preventDefault();
          dom(event.currentTarget).setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width: shown };
          setLive(shown);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          setLive(drag.current.width + drag.current.x - event.clientX);
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onDoubleClick={() => onResize(bound(420))}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 64 : 16;
          const next = event.key === "ArrowLeft"
            ? shown + step
            : event.key === "ArrowRight"
            ? shown - step
            : event.key === "Home"
            ? 280
            : event.key === "End"
            ? room
            : null;
          if (next === null) return;
          event.preventDefault();
          onResize(bound(next));
        }}
      >
        <span
          aria-hidden="true"
          className={cn(
            "bg-border h-full w-px transition-colors group-hover/handle:bg-ring group-focus-visible/handle:bg-ring",
            live !== null && "bg-ring",
          )}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </aside>
  );
}
