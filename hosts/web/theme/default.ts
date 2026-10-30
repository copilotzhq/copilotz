/**
 * The web host's look, as data: its token vocabulary and their default
 * values, light and dark, which are Copilotz's. An app changes them with a
 * `theme` resource, merged over these like any resource (see `css.ts`):
 *
 * ```ts
 * resources: {
 *   theme: {
 *     radius: "8px",
 *     font: { sans: '"Inter", sans-serif', url: "https://fonts.googleapis.com/css2?family=Inter:wght@400..700&display=swap" },
 *     logo: { mark: { viewBox: "0 0 32 32", paths: [{ d: "M4 4h24v24H4z", fill: "currentColor" }] } },
 *     light: { primary: "#0f766e" },
 *     dark: { primary: "#2dd4bf", "primary-foreground": "#042f2e" },
 *   },
 * }
 * ```
 *
 * Token names are shadcn's, so its themes and theme generators work as they
 * are: `background`/`foreground`, `card`, `popover`, `primary`, `secondary`,
 * `muted`, `accent` and `destructive` (each with its `-foreground`), `border`,
 * `input`, `ring`, `sidebar-*`, `radius`, `font-sans`, `font-mono` and
 * `shadow-*`. To them the toolkit adds `font-display` (headings), `success`,
 * `warning` and `info`, and `bubble`/`bubble-foreground` (the reader's own
 * messages). Each colour role (`primary`, `destructive`, `success`,
 * `warning`, `info`) is a fill (and icons), its `-foreground` (text on the
 * fill), `-text` (the role as text on the page), `-soft` (a tinted surface)
 * and `-border` (a tinted border). They derive from their role
 * (`color-mix()` over it), as `bubble` and the sidebar's derive from
 * `primary`, so a brand sets `primary` alone, and a theme that recolours a
 * status sets that status alone. Copilotz's focus `ring` is its own colour
 * on a light screen (the logo's blue): a brand sets it too for a focus in
 * its own. Every token is a CSS variable: `var(--primary)`.
 */
import { COPILOTZ_FULL, COPILOTZ_MARK } from "./copilotz.ts";
import type { Picture } from "./picture.ts";

/** A theme: what an app changes of the defaults. Any token may be set, or `null`ed. */
export type Theme = {
  /** The base corner radius; the toolkit's radii (`--radius-xs` … `--radius-3xl`) scale with it. */
  radius?: string;
  /**
   * The fonts, given whole: a theme that gives `font` names all it uses, and
   * what it doesn't name is the system's (headings, the text's).
   */
  font?: {
    /** The text's font stack. */
    sans?: string;
    /** Headings' and display text's (the text's, unless given). */
    display?: string;
    /** Code's. */
    mono?: string;
    /**
     * A stylesheet that loads the fonts: Google Fonts' (`https://fonts.googleapis.com/…`), or
     * the app's own, served with its font files (`/assets/fonts/brand.css`; see `webServer`).
     */
    url?: string;
    /**
     * The font files every page shows at once (the text's and headings' basic
     * Latin), on the app's own origin: fetched with the page, not once the
     * text first needs them, so it doesn't change face as it appears.
     */
    preload?: string[];
  };
  /**
   * The brand's logo, given whole: a theme that gives `logo` gives its own,
   * so one brand's mark never sits beside another's name. `null`: none (the
   * app's name alone).
   */
  logo?: {
    /** The mark alone: the sidebar, home, and the page's icon. Square is best. */
    mark?: Picture;
    /** The mark with the name, as drawn: signing in, the sidebar. Without it, the mark and the name. */
    full?: Picture;
    /**
     * The page's icon as a PNG, square and opaque (180 px), where an SVG icon
     * won't do: older browsers, and phones' home screens.
     */
    icon?: string;
  } | null;
  /** Tokens for a light screen, by name (no `--`): `{ primary: "#0f766e" }`. */
  light?: Record<string, string | null>;
  /** Tokens for a dark one. */
  dark?: Record<string, string | null>;
};

/** The system's text fonts: the stack any theme's own fonts fall back to. */
export const SYSTEM_SANS =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", ' +
  'Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"';

/** The system's code fonts. */
export const SYSTEM_MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** Follows `primary` in both schemes, unless a theme sets it. */
const brand = {
  "sidebar-primary": "var(--primary)",
  "sidebar-primary-foreground": "var(--primary-foreground)",
  "sidebar-foreground": "var(--foreground)",
  "sidebar-accent": "var(--accent)",
  "sidebar-accent-foreground": "var(--accent-foreground)",
  "sidebar-border": "var(--border)",
  "sidebar-ring": "var(--ring)",
  "card-foreground": "var(--foreground)",
  "popover-foreground": "var(--foreground)",
  "accent-foreground": "var(--foreground)",
};

/**
 * Copilotz: navy and white, with the logo's cyan and blue. On a light
 * screen, a navy brand (buttons, your own messages) on cool slate greys,
 * with focus in the logo's blue; on a dark one, a deep navy page and a cyan
 * brand. Manrope for text and Space Grotesk for
 * headings, served by the web host itself (`/assets/copilotz/`), so no visitor's
 * browser asks Google for them. Every text colour here is at least 4.5:1
 * against what it sits on (WCAG AA), and the focus ring 3:1.
 */
export const DEFAULT_THEME: Theme = {
  radius: "12px",
  font: {
    sans: `"Manrope", ${SYSTEM_SANS}`,
    display: `"Space Grotesk", "Manrope", ${SYSTEM_SANS}`,
    mono: SYSTEM_MONO,
    url: "/assets/copilotz/fonts.css",
    preload: [
      "/assets/copilotz/manrope-v23-latin.woff2",
      "/assets/copilotz/space-grotesk-v22-latin.woff2",
    ],
  },
  logo: { mark: COPILOTZ_MARK, full: COPILOTZ_FULL, icon: "/assets/copilotz/icon.png" },
  light: {
    ...brand,
    background: "#ffffff",
    foreground: "#131b2f",
    card: "#ffffff",
    popover: "#ffffff",
    primary: "#131b2f",
    "primary-foreground": "#ffffff",
    secondary: "#edf1f7",
    "secondary-foreground": "#334058",
    muted: "#f1f4f9",
    "muted-foreground": "#586579",
    accent: "#e9eef6",
    destructive: "#d92d20",
    "destructive-foreground": "#ffffff",
    success: "#067647",
    "success-foreground": "#ffffff",
    warning: "#f59e0b",
    "warning-foreground": "#231400",
    info: "#1a6ae6",
    "info-foreground": "#ffffff",
    border: "#e2e8f0",
    input: "#cdd6e3",
    ring: "#2f87f4",
    sidebar: "#f8fafc",
    "primary-text": "var(--primary)",
    "destructive-text": "color-mix(in oklab, var(--destructive) 80%, var(--foreground))",
    "success-text": "color-mix(in oklab, var(--success) 82%, var(--foreground))",
    "warning-text": "color-mix(in oklab, var(--warning) 55%, var(--foreground))",
    "info-text": "color-mix(in oklab, var(--info) 88%, var(--foreground))",
    "primary-soft": "color-mix(in oklab, var(--primary) 7%, var(--background))",
    "primary-border": "color-mix(in oklab, var(--primary) 24%, var(--background))",
    bubble: "var(--primary)",
    "bubble-foreground": "var(--primary-foreground)",
    "destructive-soft": "color-mix(in oklab, var(--destructive) 6%, var(--background))",
    "destructive-border": "color-mix(in oklab, var(--destructive) 24%, var(--background))",
    "success-soft": "color-mix(in oklab, var(--success) 8%, var(--background))",
    "success-border": "color-mix(in oklab, var(--success) 30%, var(--background))",
    "warning-soft": "color-mix(in oklab, var(--warning) 12%, var(--background))",
    "warning-border": "color-mix(in oklab, var(--warning) 40%, var(--background))",
    "info-soft": "color-mix(in oklab, var(--info) 7%, var(--background))",
    "info-border": "color-mix(in oklab, var(--info) 28%, var(--background))",
    "shadow-sm": "0 1px 2px rgb(19 27 47 / .06)",
    "shadow-md": "0 1px 2px rgb(19 27 47 / .04), 0 6px 20px rgb(19 27 47 / .07)",
    "shadow-lg": "0 18px 60px rgb(19 27 47 / .22)",
  },
  dark: {
    ...brand,
    background: "#0c101d",
    foreground: "#eaf0f5",
    card: "#141a29",
    popover: "#161d2d",
    primary: "#1bdada",
    "primary-foreground": "#0f1524",
    secondary: "#1c2333",
    "secondary-foreground": "#c5cfdc",
    muted: "#191f2e",
    "muted-foreground": "#9ba7b8",
    accent: "#222a3c",
    destructive: "#ff9187",
    "destructive-foreground": "#2a0f0c",
    success: "#5dd39b",
    "success-foreground": "#062b1b",
    warning: "#fbbf24",
    "warning-foreground": "#2a1d05",
    info: "#6aaeff",
    "info-foreground": "#0b2440",
    border: "#232b3c",
    input: "#313a4f",
    ring: "var(--primary)",
    sidebar: "#0f1422",
    "primary-text": "color-mix(in oklab, var(--primary) 78%, var(--foreground))",
    "destructive-text": "var(--destructive)",
    "success-text": "var(--success)",
    "warning-text": "var(--warning)",
    "info-text": "var(--info)",
    "primary-soft": "color-mix(in oklab, var(--primary) 14%, var(--background))",
    "primary-border": "color-mix(in oklab, var(--primary) 42%, var(--background))",
    bubble: "color-mix(in oklab, var(--primary) 18%, var(--card))",
    "bubble-foreground": "var(--foreground)",
    "destructive-soft": "color-mix(in oklab, var(--destructive) 12%, var(--background))",
    "destructive-border": "color-mix(in oklab, var(--destructive) 32%, var(--background))",
    "success-soft": "color-mix(in oklab, var(--success) 10%, var(--background))",
    "success-border": "color-mix(in oklab, var(--success) 28%, var(--background))",
    "warning-soft": "color-mix(in oklab, var(--warning) 12%, var(--background))",
    "warning-border": "color-mix(in oklab, var(--warning) 32%, var(--background))",
    "info-soft": "color-mix(in oklab, var(--info) 10%, var(--background))",
    "info-border": "color-mix(in oklab, var(--info) 28%, var(--background))",
    "shadow-sm": "0 1px 2px rgb(0 0 0 / .45)",
    "shadow-md": "0 1px 2px rgb(0 0 0 / .3), 0 8px 24px rgb(0 0 0 / .32)",
    "shadow-lg": "0 18px 64px rgb(0 0 0 / .6)",
  },
};
