/** Touch drag on a conversation's handle; native mouse drag stays separate. @module */
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { browser, dom, domEvent } from "@copilotz/copilotz/web/kit";
import { spaceDragScrollSpeed, TouchSpaceDrag } from "../model.ts";

type Options = {
  enabled: boolean;
  /** Spaces a conversation may move to, except its own. */
  eligible(threadId: string): readonly string[];
  onMove(threadId: string, spaceId: string): void;
  onCancel(): void;
};

/** One touch gesture: the handle captures the pointer, a destination list shows. */
export function useTouchSpaceDrag(options: Options): {
  drag: { threadId: string; targetId: string | null } | null;
  targets: RefObject<HTMLDivElement | null>;
  start(
    event: ReactPointerEvent<HTMLButtonElement>,
    threadId: string,
    spaceId: string | null,
  ): void;
  consumeClick(): boolean;
} {
  const current = useRef(options);
  current.current = options;
  const model = useRef(new TouchSpaceDrag());
  const capture = useRef<unknown>(null);
  const frame = useRef<number | null>(null);
  const suppress = useRef(false);
  const targets = useRef<HTMLDivElement>(null);
  const target = useRef<string | null>(null);
  const [drag, setDrag] = useState<
    { threadId: string; targetId: string | null } | null
  >(null);

  const hit = (): string | null => {
    const session = model.current.session;
    if (!session?.active || !targets.current) return null;
    const viewport = dom(targets.current);
    const element = browser.document?.elementFromPoint(session.x, session.y)
      ?.closest("[data-drop-space]");
    const id = element?.dataset.dropSpace;
    return element && viewport.contains(element) && id &&
        current.current.eligible(session.threadId).includes(id)
      ? id
      : null;
  };
  const clear = () => {
    const pointer = model.current.session?.pointerId;
    model.current.cancel();
    if (frame.current !== null) browser.cancelAnimationFrame?.(frame.current);
    frame.current = null;
    target.current = null;
    setDrag(null);
    const element = capture.current ? dom(capture.current) : undefined;
    capture.current = null;
    if (pointer !== undefined && element?.hasPointerCapture(pointer)) {
      element.releasePointerCapture(pointer);
    }
  };

  useEffect(() => {
    let last = 0;
    const tick = (now: number) => {
      const session = model.current.session;
      if (!session?.active) return;
      if (targets.current) {
        const viewport = dom(targets.current);
        const elapsed = Math.min(32, last ? now - last : 16);
        viewport.scrollTop += spaceDragScrollSpeed(
          session.x,
          session.y,
          viewport.getBoundingClientRect(),
        ) * elapsed / 1000;
      }
      last = now;
      const id = hit();
      if (id !== target.current) {
        target.current = id;
        setDrag({ threadId: session.threadId, targetId: id });
      }
      frame.current = browser.requestAnimationFrame?.(tick) ?? null;
    };
    const move = (raw: unknown) => {
      const event = domEvent(raw);
      const session = model.current.session;
      if (!session || event.pointerId !== session.pointerId) return;
      const was = session.active;
      if (
        !model.current.update(event.pointerId, event.clientX, event.clientY)
      ) {
        return;
      }
      event.preventDefault();
      suppress.current = true;
      if (!was) {
        last = 0;
        setDrag({ threadId: session.threadId, targetId: null });
        frame.current = browser.requestAnimationFrame?.(tick) ?? null;
      }
    };
    const up = (raw: unknown) => {
      const event = domEvent(raw);
      const session = model.current.session;
      if (!session || event.pointerId !== session.pointerId) return;
      session.x = event.clientX;
      session.y = event.clientY;
      const active = session.active;
      const result = model.current.release(
        event.pointerId,
        hit(),
        current.current.eligible(session.threadId),
      );
      clear();
      if (result) current.current.onMove(result.threadId, result.spaceId);
      else if (active) current.current.onCancel();
    };
    const cancel = (raw: unknown) => {
      if (!model.current.session) return;
      const event = domEvent(raw);
      if (typeof event.key === "string" && event.key !== "Escape") return;
      const active = model.current.session.active;
      suppress.current = true;
      clear();
      if (active) current.current.onCancel();
    };
    browser.addEventListener("pointermove", move, { passive: false });
    browser.addEventListener("pointerup", up);
    browser.addEventListener("pointercancel", cancel);
    browser.addEventListener("blur", cancel);
    browser.addEventListener("keydown", cancel, true);
    return () => {
      browser.removeEventListener("pointermove", move);
      browser.removeEventListener("pointerup", up);
      browser.removeEventListener("pointercancel", cancel);
      browser.removeEventListener("blur", cancel);
      browser.removeEventListener("keydown", cancel, true);
      model.current.cancel();
      if (frame.current !== null) {
        browser.cancelAnimationFrame?.(frame.current);
      }
    };
  }, []);

  return {
    drag,
    targets,
    start(event, threadId, spaceId) {
      suppress.current = false;
      if (
        !current.current.enabled || event.pointerType !== "touch" ||
        !event.isPrimary || event.button !== 0
      ) return;
      if (!current.current.eligible(threadId).length) return;
      if (
        !model.current.start(
          event.pointerId,
          threadId,
          spaceId,
          event.clientX,
          event.clientY,
        )
      ) return;
      capture.current = event.currentTarget;
      try {
        dom(event.currentTarget).setPointerCapture(event.pointerId);
      } catch {
        clear();
      }
    },
    consumeClick() {
      const value = suppress.current;
      suppress.current = false;
      return value;
    },
  };
}
