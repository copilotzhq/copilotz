/**
 * Where a popover goes beside what it belongs to: under it from its start (a menu), and after it,
 * centred beside it (a rail item's tooltip), or before it when there's no room after; never off
 * the window.
 */
import { assertEquals } from "@std/assert";
import { anchor, type Placement } from "../toolkit/anchor.tsx";
import { test } from "../../../testing/mod.ts";

type Box = { left: number; top: number; width: number; height: number };

/** Places a popover of `size` beside a target at `at`, in a window 1000 by 600: where it went. */
function placed(at: Box, size: { width: number; height: number }, placement: Placement) {
  const scope = globalThis as unknown as Record<string, unknown>;
  const before = Object.fromEntries(
    ["innerWidth", "innerHeight", "addEventListener", "removeEventListener"].map((k) => [
      k,
      Object.getOwnPropertyDescriptor(scope, k),
    ]),
  );
  const set = (key: string, value: unknown) =>
    Object.defineProperty(scope, key, { value, configurable: true, writable: true });
  set("innerWidth", 1000);
  set("innerHeight", 600);
  set("addEventListener", () => {});
  set("removeEventListener", () => {});
  const rect = (b: Box) => ({ ...b, right: b.left + b.width, bottom: b.top + b.height });
  const popover = {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    getBoundingClientRect: () => rect({ left: 0, top: 0, ...size }),
  };
  const target = { getBoundingClientRect: () => rect(at) };
  try {
    anchor(popover as unknown as HTMLElement, target as unknown as HTMLElement, placement)();
    return { left: popover.style.left, top: popover.style.top, side: popover.dataset.side };
  } finally {
    for (const [key, descriptor] of Object.entries(before)) {
      if (descriptor) Object.defineProperty(scope, key, descriptor);
      else delete scope[key];
    }
  }
}

test("under its button, from its start (a menu)", () => {
  assertEquals(
    placed({ left: 100, top: 40, width: 30, height: 30 }, { width: 200, height: 100 }, {}),
    { left: "100px", top: "76px", side: "bottom" },
  );
});

test("after it, centred beside it (a rail item's tooltip); before it when there's no room", () => {
  const rail = { left: 10, top: 200, width: 40, height: 40 };
  const tip = { width: 120, height: 24 };
  assertEquals(placed(rail, tip, { side: "end", align: "center", gap: 8 }), {
    left: "58px",
    top: "208px",
    side: "end",
  });
  assertEquals(placed(rail, tip, { side: "end", align: "start", gap: 8 }).top, "200px");
  assertEquals(placed(rail, tip, { side: "end", align: "end", gap: 8 }).top, "216px");
  // At the window's right edge, it goes before it.
  const edge = { left: 940, top: 200, width: 40, height: 40 };
  assertEquals(placed(edge, tip, { side: "end", align: "center", gap: 8 }).left, "812px");
  // Never off the window: near its foot, it stays inside.
  const low = { left: 10, top: 590, width: 40, height: 40 };
  assertEquals(placed(low, tip, { side: "end", align: "center", gap: 8 }).top, "568px");
});
