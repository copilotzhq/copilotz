/**
 * What was said, scrolled: it opens at the latest, and keeps to the bottom
 * while you're there, as replies grow. Scrolled up to read, you stay put,
 * and a button takes you back down (saying when there's something new).
 * What you send takes you down too.
 */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../../../../hosts/web/mod.ts";

/** How close to the bottom still counts as there. */
const NEAR = 80;

export function Transcript(
  { last, mine, children }: {
    /** The latest message: when it changes and it's yours, back to the bottom. */
    last?: string;
    mine?: boolean;
    children: ReactNode;
  },
): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [away, setAway] = useState(false);
  const [fresh, setFresh] = useState(false);

  const bottom = (smooth = false) => {
    const el = box.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  };

  useLayoutEffect(() => bottom(), []);
  useLayoutEffect(() => {
    if (!mine) return;
    stuck.current = true;
    setAway(false);
    bottom();
  }, [last]);
  useEffect(() => {
    // Whatever changes size (a reply growing, the composer saying who works), the bottom stays.
    const watch = new ResizeObserver((changed) => {
      if (stuck.current) bottom();
      else if (changed.some((c) => c.target === log.current)) setFresh(true);
    });
    watch.observe(log.current!);
    watch.observe(box.current!);
    return () => watch.disconnect();
  }, []);

  const scrolled = () => {
    const el = box.current!;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR;
    stuck.current = near;
    setAway(!near);
    if (near) setFresh(false);
  };

  return (
    <div className="chat-body">
      <div className="chat-transcript" ref={box} onScroll={scrolled}>
        <div className="chat-log" ref={log} role="log" aria-label="Messages">
          {children}
        </div>
      </div>
      {away
        ? (
          <Button
            size="sm"
            variant={fresh ? "primary" : "outline"}
            icon="down"
            className="chat-jump"
            onClick={() => {
              stuck.current = true;
              bottom(true);
            }}
          >
            {fresh ? "New messages" : "Jump to latest"}
          </Button>
        )
        : null}
    </div>
  );
}
