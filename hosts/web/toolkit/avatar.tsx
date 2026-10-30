/**
 * Who someone is, at a glance: a person's initial in a circle, an agent's in
 * a bright rounded square, a space's in a soft one, an org's initials (two,
 * from its first words) on a tile of its own; or, given an `icon` (an
 * emoji: an agent's), that on a soft tile of its color. Given a `picture`
 * (a person's photo, from where they signed in: an `https:` address or a
 * path on the app's own origin), that, with the initial until it loads and
 * if it fails. The color comes from the name (or a `tint` given: an org's
 * id, so renaming it keeps its colour), so someone looks the same
 * everywhere. Decorative: say the name beside it.
 */
import { type CSSProperties, type ReactNode, useState } from "react";
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
.copilotz-avatar-org { border-radius: 27%; color: #fff; font-size: max(8px, calc(var(--size) * .37)); font-weight: 700;
  letter-spacing: -.02em; background: linear-gradient(150deg, hsl(var(--hue) 58% 50%), hsl(calc(var(--hue) - 26) 60% 38%));
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / .14); text-shadow: 0 1px 1px rgb(0 0 0 / .12); }
.copilotz-avatar-picture { position: relative; }
.copilotz-avatar-picture > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.copilotz-avatar.copilotz-avatar-icon { background: hsl(var(--hue) 75% 93%); color: inherit; text-shadow: none;
  box-shadow: inset 0 0 0 1px hsl(var(--hue) 45% 84%); font-size: max(9px, calc(var(--size) * .56));
  font-weight: 400; font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", var(--font-sans); }
@media (prefers-color-scheme: dark) {
  .copilotz-avatar:not(.copilotz-avatar-agent, .copilotz-avatar-org) { background: hsl(var(--hue) 32% 25%); color: hsl(var(--hue) 85% 86%); }
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

/** An org's initials: its first two words', or its first letter. */
const initials = (name: string) => {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? [first(words[0]), first(words[1])] : [first(words[0] ?? "")];
  return letters.filter(Boolean).join("").toUpperCase() || "?";
};

/** A picture shown only from where it may come: the web, securely, or the app's own origin. */
const pictureOf = (src: string | undefined) =>
  src && (/^https:\/\/[^\s"'<>]+$/.test(src) || /^\/(?!\/)[^\s"'<>]*$/.test(src)) ? src : undefined;

export function Avatar(
  { name, kind = "person", size = 28, icon, picture, tint, title, className }: {
    name: string;
    kind?: "person" | "agent" | "space" | "org";
    size?: number;
    /** An emoji to show instead of the initial: an agent's. */
    icon?: string;
    /** A photo to show instead: a person's, from their sign-in. */
    picture?: string;
    /** What the colour comes from, when not the name: an id that never changes. */
    tint?: string;
    title?: string;
    className?: string;
  },
): ReactNode {
  const [failed, setFailed] = useState<string>();
  const glyph = icon?.trim() ? first(icon.trim()) : undefined;
  const src = pictureOf(picture);
  const photo = src && failed !== src ? src : undefined;
  const letters = kind === "org" ? initials(name) : (first(name.trim()) ?? "?").toUpperCase();
  return (
    <>
      {SHEET}
      <span
        className={`copilotz-avatar copilotz-avatar-${kind}${glyph ? " copilotz-avatar-icon" : ""}${
          photo ? " copilotz-avatar-picture" : ""
        }${className ? ` ${className}` : ""}`}
        style={{ "--hue": hue(tint ?? name), "--size": `${size}px` } as CSSProperties}
        title={title}
        aria-hidden="true"
      >
        {glyph ?? letters}
        {photo
          ? (
            <img
              src={photo}
              alt=""
              referrerPolicy="no-referrer"
              loading="lazy"
              decoding="async"
              onError={() => setFailed(photo)}
            />
          )
          : null}
      </span>
    </>
  );
}
