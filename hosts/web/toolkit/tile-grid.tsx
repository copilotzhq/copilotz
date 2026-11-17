/**
 * A home page's places as tiles: each a link with a large icon (the
 * toolkit's, or the app's own image or drawing) and its name under it,
 * wrapping into as many rows as it takes. A tile's `description` is its
 * words on hover and what screen readers say after its name.
 *
 * ```tsx
 * <TileGrid label="Modules" tiles={[
 *   { href: "/sales", label: "Sales", icon: <Icon src="/assets/modules/sales.png" />,
 *     description: "Process sales and returns." },
 *   { href: "/reports", label: "Reports", icon: "chart" },
 * ]} />
 * ```
 */
import { type ReactNode, useId } from "react";
import { cx } from "./cx.ts";
import { type IconLike, iconOf } from "./icon.tsx";
import { sheet } from "./sheet.tsx";

/** One tile: where it goes, its name and icon, and what it's for. */
export type Tile = {
  href: string;
  label: string;
  icon: IconLike;
  description?: string;
  /** Its React key (its `href` unless given). */
  key?: string;
};

const SHEET = sheet(
  "tile-grid",
  `
.copilotz-tiles { display: flex; flex-wrap: wrap; justify-content: var(--tile-justify, flex-start);
  gap: var(--tile-gap, 12px); margin: 0; padding: 0; list-style: none; }
.copilotz-tile { display: flex; flex-direction: column; align-items: center; gap: var(--tile-label-gap, 10px);
  box-sizing: border-box; width: var(--tile-width, 132px); height: 100%; padding: var(--tile-padding, 16px 10px 14px);
  border: var(--tile-border-width, 1px) solid var(--tile-border-color, var(--border));
  border-radius: var(--tile-radius, var(--radius-xl)); background: var(--tile-background, var(--card));
  color: var(--tile-color, var(--card-foreground)); box-shadow: var(--tile-shadow, var(--shadow-sm));
  font-size: var(--tile-font-size, 14px); font-weight: var(--tile-font-weight, 560); line-height: 1.3;
  text-align: center; text-decoration: none; transition: background-color .15s, border-color .15s; }
.copilotz-tile:hover { background: var(--tile-hover-background, var(--muted));
  color: var(--tile-hover-color, var(--tile-color, var(--card-foreground)));
  text-decoration: var(--tile-hover-decoration, none); }
.copilotz-tile-icon { display: grid; place-items: center; width: var(--tile-icon-size, 40px); height: var(--tile-icon-size, 40px);
  border-radius: var(--tile-icon-radius, 0); overflow: hidden; color: var(--tile-icon-color, var(--primary-text)); }
.copilotz-tile-icon > .copilotz-icon, .copilotz-tile-icon > svg, .copilotz-tile-icon > img { width: 100%; height: 100%; }
`,
);

export function TileGrid(
  { tiles, label, className }: {
    tiles: Tile[];
    /** What the tiles are, said to screen readers. */
    label?: string;
    className?: string;
  },
): ReactNode {
  const id = useId();
  return (
    <>
      {SHEET}
      <ul className={cx("copilotz-tiles", className)} aria-label={label}>
        {tiles.map((tile, i) => {
          const about = tile.description ? `${id}-${i}` : undefined;
          return (
            <li key={tile.key ?? tile.href}>
              <a
                className="copilotz-tile"
                href={tile.href}
                title={tile.description}
                aria-describedby={about}
              >
                <span className="copilotz-tile-icon">{iconOf(tile.icon, 40)}</span>
                <span>{tile.label}</span>
                {about ? <span id={about} className="copilotz-sr">{tile.description}</span> : null}
              </a>
            </li>
          );
        })}
      </ul>
    </>
  );
}
