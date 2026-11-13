/**
 * The command palette's steps: a value picked goes to the nearest step that
 * asks for one, with the palette, so that step may ask something of its own
 * first (`palette.push`); and a step's note is words, or what says them (an
 * element: a View read once it's asked).
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { Palette } from "../palette/palette.tsx";
import {
  closePalette,
  openPalette,
  type PaletteControl,
  type PaletteStep,
  pickIn,
} from "../palette/state.ts";
import { test } from "../../../testing/mod.ts";

const control = (pushed: PaletteStep[] = []): PaletteControl => ({
  search: "",
  push: (step) => void pushed.push(step),
  back: () => {},
  close: () => {},
  pick: () => Promise.resolve(),
  dialog: () => {},
});

test("a value picked goes to the nearest step that asks, with the palette", async () => {
  const heard: [string, unknown, PaletteControl][] = [];
  const asks = (name: string): PaletteStep => ({
    title: name,
    pick: (value, palette) => {
      heard.push([name, value, palette]);
      return `${name} took it`;
    },
  });
  const pushed: PaletteStep[] = [];
  const palette = control(pushed);
  // The latest that asks: past one that doesn't, and the palette's first step (none).
  assertEquals(
    await pickIn([undefined, asks("first"), asks("move"), { title: "list" }], "s2", palette),
    "move took it",
  );
  assertEquals(heard.map(([name, value]) => [name, value]), [["move", "s2"]]);
  assertEquals(heard[0][2], palette);
  // So a pick may open a step of its own: whether to move there.
  const asking: PaletteStep = {
    title: "Move to…",
    pick: (_, p) => p.push({ title: "Move here?", confirm: true }),
  };
  await pickIn([asking], "s2", palette);
  assertEquals(pushed.map((s) => s.title), ["Move here?"]);
  // Nothing asks: nothing happens.
  assertEquals(await pickIn([undefined, { title: "list" }], "s2", palette), undefined);
});

test("a step's note is words, or an element drawn under the field", () => {
  try {
    openPalette({
      title: "Move “Plan” to Launch?",
      confirm: true,
      note: <span className="who">Everyone in Launch will see it.</span>,
      items: () => [],
    });
    const drawn = renderToStaticMarkup(<Palette sources={[]} hints={{}} />);
    assertStringIncludes(
      drawn,
      '<div class="copilotz-palette-note"><span class="who">Everyone in Launch will see it.</span></div>',
    );
    openPalette({
      title: "Archive Launch?",
      confirm: true,
      note: "Its chats stay.",
      items: () => [],
    });
    assertStringIncludes(
      renderToStaticMarkup(<Palette sources={[]} hints={{}} />),
      '<div class="copilotz-palette-note">Its chats stay.</div>',
    );
  } finally {
    closePalette();
  }
});
