/**
 * A space's latest chats, under it in the sidebar (kind `chats.recent`, item
 * `{ _id }`, the space): a handful, newest first, each a link that opens it
 * full screen, the open one marked (`hints.path`); then all of them, on the
 * space's Chats tab.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Icon, NavItem, Skeleton, Time } from "../../../../../hosts/web/mod.ts";
import { type Listed, titleOf } from "./listed.ts";
import { STYLE } from "./style.ts";

/** How many show under a space. */
const SHOWN = 5;

export const recentView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const space = item._id ?? "";
  const threads = ctx.db.collection("thread").query<Listed[]>("recent", {
    limit: SHOWN,
    in: space,
  }).value;
  const style = <style href="chat-web" precedence="copilotz">{STYLE}</style>;
  if (threads === undefined) {
    return (
      <ul className="chats-recent" aria-busy="true">
        {style}
        <Skeleton as="li" height={30} />
      </ul>
    );
  }
  if (!threads.length) {
    return (
      <p className="chats-recent-none">
        {style}
        No chats yet
      </p>
    );
  }
  return (
    <ul className="chats-recent" aria-label="Latest chats">
      {style}
      {threads.map((t) => {
        const path = `/thread/${encodeURIComponent(t._id)}`;
        return (
          <li key={t._id}>
            <NavItem
              href={`${path}?in=${encodeURIComponent(space)}`}
              current={ctx.hints.path === path ? "page" : undefined}
              end={<Time at={t.at} />}
              title={titleOf(t)}
            >
              {titleOf(t)}
            </NavItem>
          </li>
        );
      })}
      <li>
        <NavItem
          quiet
          href={`/space/${encodeURIComponent(space)}?tab=chats`}
          end={<Icon name="chevron" size={14} />}
        >
          All chats
        </NavItem>
      </li>
    </ul>
  );
};
