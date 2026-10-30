/**
 * The spaces you reach, for the sidebar (kind `spaces`): Personal first,
 * then shared spaces by name, each a link to its page, with what it shows
 * under it once unfolded (its latest chats: the `spaceSidebar` resource);
 * where you work (`hints.in`) and the page open (`hints.path`) marked.
 * Making a space works there next, and opens its page. Archived spaces are
 * listed apart, folded under Archived.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { go, Skeleton } from "../../../../../hosts/web/mod.ts";
import type { Reached, SpaceSidebar } from "../../contract.ts";
import { STYLE } from "./style.ts";
import { spacePath } from "./tabs.ts";
import { SpaceTree } from "./tree.tsx";
import { apart } from "./who.ts";

export const spacesView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  const under = Object.values((ctx.resources.spaceSidebar ?? {}) as Record<string, SpaceSidebar>)
    .filter((u) => u?.view)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const style = <style href="spaces-web" precedence="copilotz">{STYLE}</style>;
  if (spaces === undefined) {
    return (
      <ul className="spaces" aria-busy="true">
        {style}
        {[0, 1].map((i) => <Skeleton key={i} as="li" height={36} />)}
      </ul>
    );
  }
  const { active, archived } = apart(spaces);
  return (
    <>
      {style}
      <SpaceTree
        spaces={active}
        archived={archived}
        here={typeof ctx.hints.in === "string" ? ctx.hints.in : undefined}
        path={typeof ctx.hints.path === "string" ? ctx.hints.path : undefined}
        under={under}
        viewer={ctx.viewer?.name ?? ""}
        create={async (name) => {
          const { space } = await ctx.call<{ space: string }>("space.create", { name });
          go(spacePath(space));
        }}
      />
    </>
  );
};
