/**
 * Glyphs boards draw that the toolkit's icons don't have yet: a board, a
 * calendar, a label, a description's lines, a grip, and each stage of work
 * (Backlog's dashed ring, To do's ring, Doing half full, In review nearly
 * full, Blocked crossed, Done checked). Line glyphs on the toolkit's 24-pixel
 * grid, in the text's colour; decorative, so said beside them.
 */
import type { ReactNode } from "react";
import type { Stage } from "../../shared/columns.ts";

const PATHS = {
  board: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM9 4v16M15 4v16",
  calendar:
    "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18M8 3v4M16 3v4",
  label:
    "M3 12.6V4a1 1 0 0 1 1-1h8.6a1 1 0 0 1 .7.3l7.4 7.4a1 1 0 0 1 0 1.4l-8.6 8.6a1 1 0 0 1-1.4 0L3.3 13.3a1 1 0 0 1-.3-.7zM8 8h.01",
  lines: "M4 6h16M4 11h16M4 16h10",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  columns: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
} as const;

export type GlyphName = keyof typeof PATHS;

export function Glyph(
  { name, size = 16, className }: { name: GlyphName; size?: number; className?: string },
): ReactNode {
  return (
    <svg
      className={className ? `board-glyph ${className}` : "board-glyph"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "grip" ? 3 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** A column's stage, as a ring that fills as work moves on; its colour is the stage's (style.ts). */
export function StageMark({ stage, size = 14 }: { stage: Stage; size?: number }): ReactNode {
  const ring = (dash?: string) => (
    <circle
      cx="8"
      cy="8"
      r="6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeDasharray={dash}
    />
  );
  const parts: Record<Stage, ReactNode> = {
    backlog: ring("2.2 2.2"),
    todo: ring(),
    doing: (
      <>
        {ring()}
        <path d="M8 4a4 4 0 0 1 0 8z" fill="currentColor" />
      </>
    ),
    review: (
      <>
        {ring()}
        <path d="M8 4a4 4 0 1 1-4 4h4z" fill="currentColor" />
      </>
    ),
    blocked: (
      <>
        <circle cx="8" cy="8" r="6.8" fill="currentColor" />
        <path
          d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"
          stroke="var(--background)"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </>
    ),
    done: (
      <>
        <circle cx="8" cy="8" r="6.8" fill="currentColor" />
        <path
          d="M5.2 8.3l1.9 1.9 3.8-4"
          fill="none"
          stroke="var(--background)"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  };
  return (
    <svg
      className="board-stage"
      data-stage={stage}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      {parts[stage]}
    </svg>
  );
}
