/**
 * A View's frame: a header (a `back` link, an `icon` or anything `leading`
 * such as an avatar, the `title` with `badges` after it, `actions` at its
 * end, a `description` under it), then what the View shows. A section named
 * by its title, an `h1` unless given another `heading`.
 *
 * Two densities, as the View is asked for (`ctx.hints.mode`):
 *
 * - `full`, the default: a page in the main area. It scrolls, and centres
 *   what it holds at a readable `width` (`md`; `lg` for wide ones, such as a
 *   grid; `full`, all of it). On a phone, its first line keeps clear of the
 *   shell's menu button (the shell's `--copilotz-inset`).
 * - `panel`: the same View in a side panel or a drawer: tighter type and
 *   spacing, no margins of its own, and its heading an `h2`. Its container
 *   scrolls it. A `DetailList` in it stacks.
 *
 * ```tsx
 * <Page title="Memories" description="What agents remember." actions={<Button>Export</Button>}>
 *   …
 * </Page>
 * <Page density="panel" title={space.name} leading={<Avatar name={space.name} kind="space" />}
 *   badges={<Badge tone="primary">shared</Badge>} back={{ href: "/spaces", label: "Spaces" }}>
 *   <DetailList item={space} />
 * </Page>
 * ```
 */
import { type ReactNode, useId } from "react";
import { cx } from "./cx.ts";
import { Icon, type IconName } from "./icon.tsx";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "page",
  `
.copilotz-page { container: copilotz-page / inline-size; --copilotz-page-inset: 0px; }
.copilotz-page-full { height: 100%; overflow-y: auto; background: var(--background);
  --copilotz-page-inset: max(0px, calc(var(--copilotz-inset, 0px) - 12px)); }
.copilotz-page-inner { --copilotz-inset: 0px; max-width: 820px; margin: 0 auto; padding: 34px 24px 64px; }
.copilotz-page-lg > .copilotz-page-inner { max-width: 1040px; }
.copilotz-page-fill > .copilotz-page-inner { max-width: none; }
.copilotz-page-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; }
.copilotz-page-head > :first-child { margin-left: var(--copilotz-page-inset); }
.copilotz-page-back { grid-column: 1 / -1; justify-self: start; display: inline-flex; align-items: center; gap: 3px;
  margin-bottom: 10px; padding: 3px 8px 3px 3px; border-radius: var(--radius-sm); color: var(--muted-foreground);
  font-size: 13px; font-weight: 540; line-height: 1.3; text-decoration: none; transition: background-color .15s, color .15s; }
.copilotz-page-head > .copilotz-page-back { margin-left: calc(var(--copilotz-page-inset) - 3px); }
.copilotz-page-back:hover { background: var(--accent); color: var(--accent-foreground); }
.copilotz-page-lead { grid-column: 1; display: flex; margin-right: 14px; }
.copilotz-page-icon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: var(--radius-lg);
  background: var(--primary-soft); color: var(--primary-text); }
.copilotz-page-titles { grid-column: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-width: 0; }
.copilotz-page-title { margin: 0; min-width: 0; font-family: var(--font-display); font-size: 28px; line-height: 1.2;
  letter-spacing: -.025em; font-weight: 680; color: var(--foreground); overflow-wrap: anywhere; }
.copilotz-page-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.copilotz-page-actions { grid-column: 3; display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center;
  gap: 8px; margin-left: 16px; }
.copilotz-page-description { grid-column: 2 / -1; max-width: 560px; margin: 8px 0 0; color: var(--muted-foreground); }
.copilotz-page-body { margin-top: 20px; }
@container copilotz-page (max-width: 560px) {
  .copilotz-page-inner { padding: 16px 16px 48px; }
  .copilotz-page-lead { margin-block: -3px; margin-right: 12px; }
  .copilotz-page-icon { width: 32px; height: 32px; border-radius: var(--radius-md); }
  .copilotz-page-title { font-size: 22px; line-height: 26px; letter-spacing: -.02em; }
  .copilotz-page-description { grid-column: 1 / -1; }
  .copilotz-page-actions { margin-left: 10px; gap: 6px; }
  .copilotz-page-body { margin-top: 18px; }
}
.copilotz-page-panel > .copilotz-page-inner { max-width: none; margin: 0; padding: 16px 16px 20px; }
.copilotz-page-panel .copilotz-page-back { margin-bottom: 6px; }
.copilotz-page-panel .copilotz-page-lead { margin-right: 10px; }
.copilotz-page-panel .copilotz-page-icon { width: 30px; height: 30px; border-radius: var(--radius-md); }
.copilotz-page-panel .copilotz-page-title { font-size: 16px; line-height: 1.35; letter-spacing: -.01em; font-weight: 650; }
.copilotz-page-panel .copilotz-page-actions { margin-left: 10px; gap: 4px; }
.copilotz-page-panel .copilotz-page-description { margin-top: 3px; font-size: 13px; line-height: 1.45; }
.copilotz-page-panel .copilotz-page-body { margin-top: 14px; font-size: 14px; }
`,
);

export function Page(
  {
    title,
    heading,
    id,
    description,
    icon,
    leading,
    back,
    badges,
    actions,
    density = "full",
    width = "md",
    className,
    children,
  }: {
    title: ReactNode;
    /** The title's level: `h1` for a page, `h2` in a panel, unless given. */
    heading?: "h1" | "h2" | "h3";
    /** The title's id (the section is labelled by it): one of its own, unless given. */
    id?: string;
    description?: ReactNode;
    /** An icon before the title, in a soft tile. */
    icon?: IconName;
    /** Anything before the title instead: an avatar. */
    leading?: ReactNode;
    /** A link back to where this came from, over the title. */
    back?: { href: string; label: string };
    /** Labels after the title (`Badge`s). */
    badges?: ReactNode;
    /** What to do here, at the title's end (`Button`s). */
    actions?: ReactNode;
    density?: "full" | "panel";
    /** How wide what it holds may grow, in `full` density. */
    width?: "md" | "lg" | "full";
    className?: string;
    children?: ReactNode;
  },
): ReactNode {
  const own = useId();
  const titleId = id ?? own;
  const panel = density === "panel";
  const Heading = heading ?? (panel ? "h2" : "h1");
  const lead = icon
    ? (
      <span className="copilotz-page-icon">
        <Icon name={icon} size={panel ? 16 : 20} />
      </span>
    )
    : leading;
  return (
    <section
      aria-labelledby={titleId}
      data-density={density}
      className={cx(
        "copilotz-page",
        `copilotz-page-${density}`,
        !panel && width === "lg" && "copilotz-page-lg",
        !panel && width === "full" && "copilotz-page-fill",
        className,
      )}
    >
      {SHEET}
      <div className="copilotz-page-inner">
        <header className="copilotz-page-head">
          {back
            ? (
              <a className="copilotz-page-back" href={back.href}>
                <Icon name="chevron-left" size={15} />
                {back.label}
              </a>
            )
            : null}
          {lead ? <span className="copilotz-page-lead">{lead}</span> : null}
          <div className="copilotz-page-titles">
            <Heading id={titleId} className="copilotz-page-title">{title}</Heading>
            {badges ? <span className="copilotz-page-badges">{badges}</span> : null}
          </div>
          {actions ? <div className="copilotz-page-actions">{actions}</div> : null}
          {description ? <p className="copilotz-page-description">{description}</p> : null}
        </header>
        <div className="copilotz-page-body">{children}</div>
      </div>
    </section>
  );
}
