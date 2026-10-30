/**
 * The app's other brand, "Harbor", as data: one `theme` resource (a teal
 * primary on warm stone greys, tighter corners, its own typefaces and its own
 * mark: the sun setting over the water, on a teal tile). The browser runs it
 * with the app's front ends (harbor.tsx); the server puts it in the page for
 * the first paint, draws its icon from the mark, and serves its fonts itself
 * (web.ts: fonts/, at /assets/fonts/), so visitors' browsers never ask Google
 * for them.
 */
import { definePlugin, type Plugin } from "../../runtime/mod.ts";

/** Harbor's teal, the tile its mark sits on. */
const TEAL = "#0f766e";
/** What's drawn on the tile. */
const FOAM = "#ffffff";
/** A wave across the tile, from its left edge at `y`: two crests, 2.2 thick. */
const wave = (y: number) =>
  `M6 ${y}c2.5 0 2.5-1.6 5-1.6s2.5 1.6 5 1.6 2.5-1.6 5-1.6 2.5 1.6 5 1.6v2.2` +
  "c-2.5 0-2.5-1.6-5-1.6s-2.5 1.6-5 1.6-2.5-1.6-5-1.6-2.5 1.6-5 1.6z";

export const harbor: Plugin = definePlugin({
  name: "harbor",
  resources: {
    theme: {
      radius: "7px",
      font: {
        sans: '"Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif',
        mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        // Its own copy of Google's (fonts/harbor.css): JetBrains Mono 400 and 600, Plus Jakarta
        // Sans 400 to 800. Google's own would do too: https://fonts.googleapis.com/css2?family=…
        url: "/assets/fonts/harbor.css",
        preload: ["/assets/fonts/plus-jakarta-sans-v12-latin.woff2"],
      },
      // Its mark alone: beside it, the app's name ("Harbor"), and its icon is the mark.
      logo: {
        mark: {
          viewBox: "0 0 32 32",
          paths: [
            {
              fill: TEAL,
              d: "M8 0h16a8 8 0 0 1 8 8v16a8 8 0 0 1-8 8H8a8 8 0 0 1-8-8V8a8 8 0 0 1 8-8z",
            },
            { fill: FOAM, d: "M10.5 13.5a5.5 5.5 0 0 1 11 0z" },
            { fill: FOAM, d: wave(17.5) },
            { fill: FOAM, d: wave(21.9) },
          ],
        },
      },
      light: {
        background: "#ffffff",
        foreground: "#1c1917",
        primary: TEAL,
        "primary-foreground": "#ffffff",
        secondary: "#f5f4f2",
        "secondary-foreground": "#44403c",
        muted: "#f5f4f2",
        "muted-foreground": "#69635d",
        accent: "#efedea",
        border: "#e7e4e0",
        input: "#d6d2cd",
        sidebar: "#faf9f7",
        ring: "var(--primary)",
        bubble: "color-mix(in oklab, var(--primary) 10%, var(--background))",
        "bubble-foreground": "color-mix(in oklab, var(--primary) 30%, var(--foreground))",
      },
      dark: {
        background: "#151312",
        foreground: "#f0eeeb",
        card: "#1e1b19",
        popover: "#221f1d",
        primary: "#2dd4bf",
        "primary-foreground": "#042f2e",
        secondary: "#262321",
        "secondary-foreground": "#d6d2cd",
        muted: "#24211f",
        "muted-foreground": "#aaa39c",
        accent: "#2c2927",
        border: "#2e2a27",
        input: "#3d3834",
        sidebar: "#191715",
        bubble: "color-mix(in oklab, var(--primary) 22%, var(--background))",
      },
    },
  },
});
