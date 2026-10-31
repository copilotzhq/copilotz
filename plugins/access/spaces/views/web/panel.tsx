/**
 * A space in the side panel beside a chat (kind `space.panel`, the web
 * shell's `panel`): its name, a link to its page, and its tabs, compact:
 * the same Views as on its page, with hints `{ in, mode: "panel" }`, each
 * read only once chosen (and kept while the panel is open, so a terminal
 * keeps what it showed). The tab last chosen opens next time. Where tabs
 * don't all fit, the others show as icons.
 */
import { type ReactNode, useEffect, useId, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Avatar,
  Icon,
  IconButton,
  keep,
  kept,
  LazyView,
  Skeleton,
  Tabs,
} from "../../../../../hosts/web/mod.ts";
import type { Reached } from "../../contract.ts";
import { STYLE } from "./style.ts";
import { chosen, type ShownTab, spacePath, tabsOf } from "./tabs.ts";
import { ownersOf, spaceName } from "./who.ts";
import { namesIn } from "../../shared/names.ts";

export const spacePanelView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? "";
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  const style = <style href="spaces-web" precedence="copilotz">{STYLE}</style>;
  if (spaces === undefined) {
    return (
      <div className="space-panel" aria-busy="true">
        {style}
        <div className="space-panel-head">
          <Skeleton width={160} height={22} />
        </div>
      </div>
    );
  }
  const space = spaces.find((s) => s._id === id);
  if (!space) {
    return (
      <div className="space-panel space-panel-missing">
        {style}
        <p>This chat's space isn't one of yours.</p>
      </div>
    );
  }
  return (
    <>
      {style}
      <SpacePanel
        space={space}
        tabs={tabsOf(ctx.resources.spaceTabs)}
        viewer={ctx.viewer?.name}
        names={namesIn(ctx, ownersOf([space], ctx.viewer?.name))}
      />
    </>
  );
};

function SpacePanel(
  { space, tabs, viewer = "", names }: {
    space: Reached;
    tabs: ShownTab[];
    viewer?: string;
    names: Record<string, string>;
  },
): ReactNode {
  const key = `copilotz-space-panel-tab:${viewer}`;
  const [asked, setAsked] = useState(() => kept(key) ?? undefined);
  const tab = chosen(tabs, asked);
  const [opened, setOpened] = useState<string[]>(() => tab ? [tab.key] : []);
  useEffect(() => {
    if (tab && !opened.includes(tab.key)) setOpened([...opened, tab.key]);
  }, [tab?.key]);
  const id = useId();
  const personal = space.kind === "personal";
  const name = spaceName(space, viewer, names);
  return (
    <section className="space-panel" aria-label={`${name}, beside this chat`}>
      <header className="space-panel-head">
        {personal
          ? (
            <span className="space-panel-mark">
              <Icon name="person" size={14} />
            </span>
          )
          : <Avatar name={space.name} kind="space" size={26} />}
        <div className="space-panel-titles">
          <h2>{name}</h2>
          <span>{personal ? "Just you" : "Shared space"}</span>
        </div>
        <IconButton
          icon="external"
          label={`Open ${name}'s page`}
          size="sm"
          href={spacePath(space._id, tab?.key)}
        />
      </header>
      {tabs.length > 1
        ? (
          <Tabs
            label={`${name}'s tabs`}
            className="space-panel-tabs"
            value={tab?.key ?? ""}
            panel={`${id}-tab`}
            onChange={(next) => {
              setAsked(next);
              keep(key, next);
            }}
            tabs={tabs.map((t) => ({
              value: t.key,
              label: <span className="space-panel-tab-label">{t.title}</span>,
              ...(t.icon ? { icon: t.icon } : {}),
              title: t.title,
            }))}
          />
        )
        : null}
      <div id={`${id}-tab`} role="tabpanel" className="space-panel-body">
        {tabs.filter((t) => opened.includes(t.key)).map((t) => (
          <div key={t.key} className="space-panel-tab" hidden={t.key !== tab?.key}>
            <LazyView
              kind={t.view}
              item={{ _id: space._id }}
              hints={{ in: space._id, mode: "panel" }}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
