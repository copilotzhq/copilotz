/**
 * Views observed for what they return, not drawn: the palette's lists, each
 * a front end's View, as the page's person (`web()`'s connection), while the
 * palette is open. Given new hints (what's typed), a View is observed again,
 * and keeps its last answer until the new one is ready, so nothing blinks
 * (what both read stays watched, and answers at once); one no longer asked
 * for, or the palette closed, stops.
 */
import { useEffect, useReducer, useRef } from "react";
import type { Observation } from "../../../runtime/mod.ts";
import { session } from "../session.ts";

export type Source = { kind: string; item?: unknown; hints?: Record<string, unknown> };

type Slot = {
  /** What it shows, and what it was asked with. */
  shown?: Observation;
  key?: string;
  /** Asked again, not ready yet. */
  next?: { key: string; observation: Observation };
  off?: () => void;
};

const keyOf = (source: Source) =>
  JSON.stringify([source.kind, source.item ?? {}, source.hints ?? {}]);

const closed = (slot: Slot) => {
  slot.off?.();
  slot.shown?.close();
  slot.next?.observation.close();
};

/** Each source's latest answer (undefined until its first), and whether any is still to come. */
export function useOutputs(sources: Source[]): { values: unknown[]; loading: boolean } {
  const slots = useRef(new Map<string, Slot>());
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const ids = sources.map((s, i) => `${i}:${s.kind}`);
  const keys = sources.map(keyOf);

  useEffect(() => {
    const { client, viewer } = session;
    if (!client) return;
    sources.forEach((source, i) => {
      const id = ids[i];
      const key = keys[i];
      const slot = slots.current.get(id) ?? slots.current.set(id, {}).get(id)!;
      if (slot.key === key || slot.next?.key === key) return;
      slot.next?.observation.close();
      const observation = client.observe("web", source.kind, source.item ?? {}, {
        ...(viewer ? { viewer } : {}),
        hints: source.hints ?? {},
      });
      slot.next = { key, observation };
      void observation.ready.then(() => {
        if (slot.next?.observation !== observation) return;
        closed({ ...slot, next: undefined });
        slot.shown = observation;
        slot.key = key;
        slot.next = undefined;
        slot.off = observation.subscribe(redraw);
        redraw();
      });
    });
    for (const [id, slot] of slots.current) {
      if (ids.includes(id)) continue;
      closed(slot);
      slots.current.delete(id);
    }
  }, [JSON.stringify(keys)]);

  useEffect(() => () => {
    for (const slot of slots.current.values()) closed(slot);
    slots.current.clear();
  }, []);

  const outputs = ids.map((id) => slots.current.get(id)?.shown?.get());
  return {
    values: outputs.map((o) => o?.status === "ready" ? o.value : undefined),
    loading: outputs.some((o) => !o || o.status === "loading"),
  };
}
