/**
 * The terminal's scrollback: what's done prints once, in the order it first
 * shows, above what's live, and stays in the terminal's own history. Any View
 * adds to it with `<Scrollback entries={…} />`, by key: an entry already
 * printed isn't printed again, so a View can list everything it has each
 * time it runs.
 */
import { Box, Static } from "ink";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { node } from "./part.tsx";

export type Entry = { key: string; node: unknown };

const Printing = createContext<(entries: Entry[]) => void>(() => {});

/** Holds the scrollback: one per screen, above everything it contains. */
export function ScrollbackRoot({ children }: { children: ReactNode }): ReactNode {
  const [printed, setPrinted] = useState<Entry[]>([]);
  const seen = useRef(new Set<string>());
  const print = useCallback((entries: Entry[]) => {
    const fresh = entries.filter((entry) => !seen.current.has(entry.key));
    if (!fresh.length) return;
    for (const entry of fresh) seen.current.add(entry.key);
    setPrinted((before) => [...before, ...fresh]);
  }, []);
  return (
    <Printing value={print}>
      <Static items={printed}>{(entry) => <Box key={entry.key}>{node(entry.node)}</Box>}</Static>
      {children}
    </Printing>
  );
}

/** Puts `entries` in the scrollback, the ones not printed yet. Draws nothing where it is. */
export function Scrollback({ entries }: { entries: Entry[] }): ReactNode {
  const print = useContext(Printing);
  useLayoutEffect(() => print(entries));
  return null;
}
