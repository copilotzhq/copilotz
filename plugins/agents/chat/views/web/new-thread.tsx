/** Starting a chat, from the top of the sidebar: home, where the person works. */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Button } from "../../../../../hosts/web/mod.ts";
import { STYLE } from "./style.ts";

export const newThreadView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const here = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  return (
    <>
      <style href="chat-web" precedence="copilotz">{STYLE}</style>
      <Button
        icon="compose"
        className="chat-new"
        href={here ? `/?in=${encodeURIComponent(here)}` : "/"}
        aria-current={ctx.hints.path === "/" ? "page" : undefined}
      >
        New chat
      </Button>
    </>
  );
};
