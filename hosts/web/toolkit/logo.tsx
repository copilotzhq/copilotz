/**
 * The app's logo, from its theme (`theme.logo`, Copilotz's by default): the
 * mark alone, or `full`, the mark with the name. Drawn inline, `size` pixels
 * high: what's filled `currentColor` takes the text's colour where it sits
 * (navy on a light page, near-white on a dark one), and the rest keeps the
 * brand's own colours. Given the app's `name`, the logo says it to screen
 * readers, and a theme without a full logo of its own shows it beside the
 * mark, in the display font; without a `name`, the logo is decoration. A
 * theme without a logo shows the name alone.
 *
 * ```tsx
 * <Logo size={44} />
 * <Logo variant="full" name="Copilotz" size={32} />
 * ```
 */
import { type CSSProperties, type ReactNode, useContext } from "react";
import { ThemeContext } from "../theme/context.ts";
import { aspect, type Picture, pictureOf } from "../theme/picture.ts";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "logo",
  `
.copilotz-logo { flex: none; display: inline-block; vertical-align: middle; }
img.copilotz-logo { width: auto; }
.copilotz-logo-lockup { display: inline-flex; align-items: center; gap: calc(var(--copilotz-logo) * .3);
  vertical-align: middle; }
.copilotz-logo-name { font-family: var(--font-display); font-size: calc(var(--copilotz-logo) * .62); font-weight: 700;
  line-height: 1; letter-spacing: -.02em; white-space: nowrap; }
`,
);

/** One picture, `size` high: named when it's what says the name, hidden when something else does. */
function Art(
  { picture, size, label, className }: {
    picture: Picture;
    size: number;
    label?: string;
    className?: string;
  },
): ReactNode {
  if (typeof picture === "string") {
    return (
      <img
        className={cx("copilotz-logo", className)}
        src={picture}
        height={size}
        alt={label ?? ""}
        draggable={false}
      />
    );
  }
  return (
    <svg
      className={cx("copilotz-logo", className)}
      viewBox={picture.viewBox}
      width={Math.round(size * aspect(picture) * 10) / 10}
      height={size}
      focusable="false"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {picture.paths.map((path, i) => (
        <path key={i} d={path.d} style={{ fill: path.fill ?? "currentColor" }} />
      ))}
    </svg>
  );
}

export function Logo(
  { variant = "mark", size = 28, name, className }: {
    /** The mark alone, or the mark with the name. */
    variant?: "mark" | "full";
    /** Its height, in pixels. */
    size?: number;
    /** The app's name: said, or shown beside the mark when the theme draws no full logo. */
    name?: string;
    className?: string;
  },
): ReactNode {
  const logo = useContext(ThemeContext).logo;
  const full = variant === "full" ? pictureOf(logo?.full) : undefined;
  const mark = full ? undefined : pictureOf(logo?.mark);
  if (full || (variant === "mark" && mark)) {
    return (
      <>
        {SHEET}
        <Art picture={(full ?? mark)!} size={size} label={name} className={className} />
      </>
    );
  }
  if (variant === "mark" || (!mark && !name)) return null;
  return (
    <span
      className={cx("copilotz-logo-lockup", className)}
      style={{ "--copilotz-logo": `${size}px` } as CSSProperties}
    >
      {SHEET}
      {mark ? <Art picture={mark} size={size} /> : null}
      {name ? <span className="copilotz-logo-name">{name}</span> : null}
    </span>
  );
}
