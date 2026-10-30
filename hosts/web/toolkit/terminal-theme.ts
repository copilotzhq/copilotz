/// <reference lib="dom" />
/**
 * A terminal's colours, from the theme's tokens: its surface and text, the
 * cursor and selection, and the sixteen ANSI colours, each a CSS value over
 * the theme's variables (`var(--destructive-text)` for red, `var(--info-text)`
 * for blue…), so a brand's terminal is in its colours, light and dark.
 * Terminals want colours, not CSS: `terminalTheme(element)` resolves each
 * where the terminal is (`getComputedStyle`, then a pixel drawn, which reads
 * whatever colour syntax the browser knows) as `#rrggbb` or `#rrggbbaa`. On
 * a dark surface the greys turn around, so "black" is still the faint one.
 */

/** What a terminal's theme names (xterm.js's `ITheme`). */
export type TerminalColors = Record<string, string>;

/** Every colour but the greys, for light and dark alike. */
const HUES = {
  red: "var(--destructive-text)",
  green: "var(--success-text)",
  yellow: "var(--warning-text)",
  blue: "var(--info-text)",
  magenta: "color-mix(in oklab, var(--destructive-text) 45%, var(--info-text))",
  cyan: "color-mix(in oklab, var(--info-text) 55%, var(--success-text))",
};

const bright = (toward: string) =>
  Object.fromEntries(
    Object.entries(HUES).map((
      [name, value],
    ) => [
      `bright${name[0].toUpperCase()}${name.slice(1)}`,
      `color-mix(in oklab, ${value} 78%, ${toward})`,
    ]),
  );

const BASE = {
  background: "var(--card)",
  foreground: "var(--foreground)",
  cursor: "var(--primary-text)",
  cursorAccent: "var(--card)",
  selectionBackground: "color-mix(in oklab, var(--primary-text) 24%, transparent)",
  selectionInactiveBackground: "color-mix(in oklab, var(--muted-foreground) 18%, transparent)",
  scrollbarSliderBackground: "color-mix(in oklab, var(--muted-foreground) 26%, transparent)",
  scrollbarSliderHoverBackground: "color-mix(in oklab, var(--muted-foreground) 40%, transparent)",
  scrollbarSliderActiveBackground: "color-mix(in oklab, var(--muted-foreground) 52%, transparent)",
  ...HUES,
};

/** On a light surface: black is the text, white a mid grey (so it still shows). */
export const LIGHT: TerminalColors = {
  ...BASE,
  black: "var(--foreground)",
  white: "var(--muted-foreground)",
  brightBlack: "color-mix(in oklab, var(--muted-foreground) 88%, var(--card))",
  brightWhite: "color-mix(in oklab, var(--muted-foreground) 62%, var(--card))",
  ...bright("var(--foreground)"),
};

/** On a dark one: black a faint grey, white the text. */
export const DARK: TerminalColors = {
  ...BASE,
  black: "color-mix(in oklab, var(--muted-foreground) 45%, var(--card))",
  white: "var(--secondary-foreground)",
  brightBlack: "var(--muted-foreground)",
  brightWhite: "var(--foreground)",
  ...bright("var(--foreground)"),
};

const hex = (n: number) => n.toString(16).padStart(2, "0");

/** How light a colour is (0 to 1), roughly as eyes see it. */
const lightness = ([r, g, b]: number[]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** The theme's terminal colours where `element` is. */
export function terminalTheme(element: Element): TerminalColors {
  const probe = document.createElement("span");
  probe.style.display = "none";
  element.appendChild(probe);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const pen = canvas.getContext("2d", { willReadFrequently: true })!;
  const rgba = (value: string) => {
    probe.style.color = "";
    probe.style.color = value;
    pen.clearRect(0, 0, 1, 1);
    pen.fillStyle = getComputedStyle(probe).color;
    pen.fillRect(0, 0, 1, 1);
    return [...pen.getImageData(0, 0, 1, 1).data];
  };
  try {
    const dark = lightness(rgba(BASE.background)) < 0.45;
    return Object.fromEntries(
      Object.entries(dark ? DARK : LIGHT).map(([name, value]) => {
        const [r, g, b, a] = rgba(value);
        return [name, `#${hex(r)}${hex(g)}${hex(b)}${a < 255 ? hex(a) : ""}`];
      }),
    );
  } finally {
    probe.remove();
  }
}
