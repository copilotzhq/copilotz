/// <reference lib="dom" />
/**
 * The line between two parts of a page that a person drags to share the
 * room differently: a side panel's edge. It's the browser's separator, so a
 * keyboard moves it too (arrow keys a step at a time, Home and End to the
 * least and most), and a double click puts it back (`onReset`). `edge` says
 * which side of what it resizes it's on: `start`, a panel's left edge
 * (dragging left widens it), or `end`, its right edge. Drawn as the border
 * between them, in the focus colour while it's held.
 *
 * ```tsx
 * <ResizeHandle label="Panel width" value={width} min={320} max={720} edge="start"
 *   onChange={setWidth} onReset={() => setWidth(420)} />
 * ```
 */
import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "resize-handle",
  `
.copilotz-resize { position: relative; z-index: 3; flex: none; align-self: stretch; width: 9px; margin: 0 -4px;
  padding: 0; border: 0; background: transparent; cursor: col-resize; touch-action: none; outline: none; }
.copilotz-resize::after { content: ""; position: absolute; inset: 0 4px; background: var(--border);
  transition: background-color .15s, inset .15s; }
.copilotz-resize:hover::after, .copilotz-resize:focus-visible::after, .copilotz-resize[data-held]::after {
  inset: 0 3px; background: var(--ring); }
`,
);

/** How far an arrow key moves it, in pixels. */
const STEP = 16;

export function ResizeHandle(
  { label, value, min, max, onChange, onReset, edge = "start", className }: {
    /** What it resizes, said to screen readers: "Panel width". */
    label: string;
    value: number;
    min: number;
    max: number;
    onChange(value: number): void;
    onReset?(): void;
    edge?: "start" | "end";
    className?: string;
  },
): ReactNode {
  const held = useRef<{ x: number; value: number } | undefined>(undefined);
  const [holding, setHolding] = useState(false);
  const toward = edge === "start" ? -1 : 1;
  const clamp = (next: number) => Math.round(Math.min(max, Math.max(min, next)));

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    held.current = { x: event.clientX, value };
    setHolding(true);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!held.current) return;
    onChange(clamp(held.current.value + (event.clientX - held.current.x) * toward));
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (!held.current) return;
    held.current = undefined;
    setHolding(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = {
      ArrowLeft: value - STEP * toward,
      ArrowRight: value + STEP * toward,
      Home: min,
      End: max,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onChange(clamp(next));
  };

  return (
    <>
      {SHEET}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        className={cx("copilotz-resize", className)}
        data-held={holding || undefined}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={keys}
        onDoubleClick={onReset}
      />
    </>
  );
}
