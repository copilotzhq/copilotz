/** @jsxRuntime classic */
/** @jsx React.createElement */
/**
 * How the chat shows a live tool renderer right now, for the renderer to
 * adapt: streaming while the call runs, a compact card once it settles, or
 * the full run when the reader expands it.
 * @module
 */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import { createContext, useContext, useRef } from "react";

/**
 * `live` while the call runs (stream it, follow the newest output); `card`
 * once it settled (its final state, compact: the last lines, the result);
 * `full` when the reader asked for the whole run, or outside a live frame.
 */
export type ToolDisplayMode = "live" | "card" | "full";

export type ToolDisplay = Readonly<{
  mode: ToolDisplayMode;
  /**
   * Inside the chat's live frame, whose header already names the call and
   * its state: the renderer can leave out its own title bar.
   */
  framed: boolean;
  /** Open the full run from the card (such as "Show all 240 lines"). */
  expand?(): void;
}>;

const FULL: ToolDisplay = { mode: "full", framed: false };

const ToolDisplayContext: React.Context<ToolDisplay> = createContext(FULL);

/** Provides the display to the renderer View drawn inside it. */
export const ToolDisplayProvider: React.Provider<ToolDisplay> =
  ToolDisplayContext.Provider;

/** Set when the renderer inside reads its display (and so draws its card). */
const AdaptsContext = createContext<{ current: boolean } | undefined>(
  undefined,
);

/**
 * Tracks whether the renderer drawn inside reads its display: a renderer
 * that does draws its own card; the frame clips one that doesn't.
 */
export function useAdapts(): {
  adapts: { current: boolean };
  Provider: React.Provider<{ current: boolean } | undefined>;
} {
  const adapts = useRef(false);
  return { adapts, Provider: AdaptsContext.Provider };
}

/**
 * The display a tool renderer is drawn in. Outside a live frame (a step's
 * details, a test) it is `full` and not framed. Reading it tells the frame
 * this renderer draws its own compact card.
 */
export function useToolDisplay(): ToolDisplay {
  const adapts = useContext(AdaptsContext);
  if (adapts) adapts.current = true;
  return useContext(ToolDisplayContext);
}
