/**
 * Who someone is, at a glance: a person's initial in a circle, an agent's in
 * a bright rounded square, a space's in a soft one; or, given an `icon` (an
 * emoji: an agent's), that on a soft tile of its color. The color comes from
 * the name, so someone looks the same everywhere. Decorative: say the name
 * beside it.
 */
import type { CSSProperties, ReactNode } from "react";
import { sheet } from "./sheet.tsx";

/** Hues that read well as a soft background and as a gradient. */
const HUES = [4, 22, 38, 145, 165, 188, 205, 222, 240, 258, 275, 295, 318, 340];

const hue = (name: string) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return HUES[h % HUES.length];
};

const SHEET = sheet(
  "avatar",
  `
.copilotz-avatar { --size: 28px; flex: none; display: inline-grid; place-items: center;
  width: var(--size); height: var(--size); border-radius: var(--radius-full); overflow: hidden;
  font-size: max(8px, calc(var(--size) * .42)); font-weight: 650; line-height: 1; user-select: none;
  background: hsl(var(--hue) 70% 91%); color: hsl(var(--hue) 55% 27%); }
.copilotz-avatar-agent { border-radius: 32%; color: #fff;
  background: linear-gradient(145deg, hsl(var(--hue) 82% 64%), hsl(calc(var(--hue) - 30) 74% 50%));
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / .18); text-shadow: 0 1px 1px rgb(0 0 0 / .15); }
.copilotz-avatar-space { border-radius: 28%; }
.copilotz-avatar.copilotz-avatar-icon { background: hsl(var(--hue) 75% 93%); color: inherit; text-shadow: none;
  box-shadow: inset 0 0 0 1px hsl(var(--hue) 45% 84%); font-size: max(9px, calc(var(--size) * .56));
  font-weight: 400; font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", var(--font-sans); }
@media (prefers-color-scheme: dark) {
  .copilotz-avatar:not(.copilotz-avatar-agent) { background: hsl(var(--hue) 32% 25%); color: hsl(var(--hue) 85% 86%); }
  .copilotz-avatar.copilotz-avatar-icon { background: hsl(var(--hue) 30% 22%); box-shadow: inset 0 0 0 1px hsl(var(--hue) 30% 30%); }
}
`,
);

/** The first character as people see one (an emoji with its modifiers is one). */
let graphemes: Intl.Segmenter | undefined;
const first = (text: string): string | undefined => {
  if (typeof Intl.Segmenter !== "function") return [...text][0];
  graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return graphemes.segment(text)[Symbol.iterator]().next().value?.segment;
};

export function Avatar(
  { name, kind = "person", size = 28, icon, title, className }: {
    name: string;
    kind?: "person" | "agent" | "space";
    size?: number;
    /** An emoji to show instead of the initial: an agent's. */
    icon?: string;
    title?: string;
    className?: string;
  },
): ReactNode {
  const glyph = icon?.trim() ? first(icon.trim()) : undefined;
  return (
    <>
      {SHEET}
      <span
        className={`copilotz-avatar copilotz-avatar-${kind}${glyph ? " copilotz-avatar-icon" : ""}${
          className ? ` ${className}` : ""
        }`}
        style={{ "--hue": hue(name), "--size": `${size}px` } as CSSProperties}
        title={title}
        aria-hidden="true"
      >
        {glyph ?? (first(name.trim()) ?? "?").toUpperCase()}
      </span>
    </>
  );
}
