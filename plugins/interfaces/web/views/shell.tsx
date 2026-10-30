/**
 * The web shell's View: the sidebar features fill, who's signed in, and what
 * the address opens, with the address's parameters (`hints.query`). Sidebar
 * sections hear where the person works (`in`) and the address (`path`), to
 * mark what's current. A space's page (`/space/<id>`) is in that space. A
 * page whose kind the `panel` resource is `on` offers the side panel, for
 * the space the person works in. The command palette lists what front ends
 * offer there (the `palette` resource), for where the person is: the space,
 * the address, the page open (`{ kind, id }`) and its parameters.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../runtime/mod.ts";
import { EmptyState } from "../../../../hosts/web/mod.ts";
import { userMenuOf } from "../shared/menu.ts";
import { pageOf, sourcesOf } from "../shared/palette.ts";
import { offered, type Panel } from "../shared/panel.ts";
import { Frame } from "./frame.tsx";

/** The app's name, which its logo says: the title the page came with. */
const app = globalThis.document?.title || "Copilotz";

/** A sidebar entry: the View that fills it, and a title over it (a plain link needs none). */
export type Section = { title?: string; view: string; order?: number };

export const shellView = (
  where: { path: string; space?: string; query?: Record<string, string> },
  ctx: ViewContext<ReactNode>,
): ReactNode => {
  const [kind, ...rest] = where.path.split("/").filter(Boolean).map(decodeURIComponent);
  const id = rest.join("/");
  // A space's page is in that space: what starts there starts in it.
  const space = kind === "space" && id ? id : where.space;
  const hints = space ? { in: space } : {};
  const sections = Object.entries((ctx.resources.sidebar ?? {}) as Record<string, Section | null>)
    .flatMap(([key, section]) => section ? [[key, section] as const] : [])
    .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0));
  const asked = { ...hints, ...(where.query ? { query: where.query } : {}) };
  const open = kind ? ctx.show(kind, id ? { _id: id } : {}, asked) : ctx.show("home", {}, asked);
  const panel = ctx.resources.panel as Panel | null | undefined;
  const viewer = ctx.viewer?.name ?? "";
  const label = ctx.viewer?.label;
  return (
    <Frame
      path={where.path + (where.space ?? "")}
      brand={app}
      viewer={viewer}
      {...(label ? { label } : {})}
      palette={{
        sources: sourcesOf(ctx.resources.palette),
        hints: {
          ...hints,
          path: where.path,
          page: pageOf(where.path),
          ...(where.query ? { query: where.query } : {}),
        },
      }}
      menu={userMenuOf(ctx.resources.userMenu)}
      call={ctx.call}
      panel={offered(panel, kind ?? "home", space) ? { ...panel, space: space! } : undefined}
      sidebar={sections.map(([key, section]) => (
        <section
          key={key}
          className={`copilotz-section${section.title ? " copilotz-section-titled" : ""}`}
          aria-labelledby={section.title ? `copilotz-section-${key}` : undefined}
        >
          {section.title ? <h2 id={`copilotz-section-${key}`}>{section.title}</h2> : null}
          {ctx.show(section.view, {}, { ...hints, path: where.path })}
        </section>
      ))}
    >
      {open ?? (
        <div className="copilotz-shell-empty">
          <EmptyState icon="search" heading="h1" title="Nothing here">
            This address doesn't open anything.
          </EmptyState>
        </div>
      )}
    </Frame>
  );
};
