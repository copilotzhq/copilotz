/**
 * Starting a chat, from the top of the sidebar: home, where the person works.
 * On the rail, the sidebar folded (kind `new-thread.rail`), the same as an icon.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Button, RailItem } from "../../../../../hosts/web/mod.ts";
import { STYLE } from "./style.ts";
import { say } from "./words.ts";

/** Home, where the person works: a new chat there. */
const homeOf = (ctx: ViewContext<ReactNode>) =>
  typeof ctx.hints.in === "string" ? `/?in=${encodeURIComponent(ctx.hints.in)}` : "/";

export const newThreadView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  return (
    <>
      <style href="chat-web" precedence="copilotz">{STYLE}</style>
      <Button
        icon="compose"
        className="chat-new"
        href={homeOf(ctx)}
        aria-current={ctx.hints.path === "/" ? "page" : undefined}
      >
        {say("newChat")}
      </Button>
    </>
  );
};

export const newThreadRailView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => (
  <RailItem
    href={homeOf(ctx)}
    icon="compose"
    label={say("newChat")}
    current={ctx.hints.path === "/" ? "page" : undefined}
  />
);
