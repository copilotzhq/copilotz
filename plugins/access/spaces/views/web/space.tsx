/**
 * A space's page (kind `space`, at `/space/<id>`): its header (its name,
 * renamed in place by those who manage it; Personal or shared; its people;
 * inviting someone; a new chat there), then its tabs, which front ends add
 * (`spaceTabs`, see contract.ts): the one the address asks for
 * (`?tab=computer`), the first otherwise, each a link. A tab with sections
 * (its settings, its computer) shows them around the one asked for
 * (`?tab=memories` opens Settings at Memories; see sections.tsx). The View
 * shown gets the space (`{ _id }`) and hints `{ in, mode: "page" }`. An archived space
 * says so, calmly, over its tabs, with Restore for those who manage it. A
 * space the person doesn't reach says so.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  EmptyState,
  go,
  message,
  Notice,
  Page,
  Skeleton,
  Tabs,
  Title,
} from "../../../../../hosts/web/mod.ts";
import type { Member, Reached, Request } from "../../contract.ts";
import { SpaceHeader } from "./header.tsx";
import { STYLE } from "./style.ts";
import { TabSections } from "./sections.tsx";
import { chosen, sectionOf, spacePath, tabsOf } from "./tabs.ts";
import { ownersOf, spaceName } from "./who.ts";
import { namesIn } from "../../shared/names.ts";

export const spaceView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = item._id ?? "";
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  const members = ctx.db.collection<Member>("member").find({ space: id }).value;
  const requests = ctx.db.collection<Request>("request").find({ space: id }, { sort: { at: 1 } })
    .value;
  const style = <style href="spaces-web" precedence="copilotz">{STYLE}</style>;
  if (spaces === undefined || members === undefined) {
    return (
      <Page title={<Skeleton width={220} height={30} />} width="lg" className="space-page">
        {style}
        <div className="space-loading" aria-busy="true">
          <Skeleton height={40} width="70%" />
          <Skeleton height={64} radius="xl" />
          <Skeleton height={64} radius="xl" />
        </div>
      </Page>
    );
  }
  const space = spaces.find((s) => s._id === id);
  if (!space) {
    return (
      <div className="space-missing">
        {style}
        <Title text="Not your space" />
        <EmptyState
          icon="lock"
          heading="h1"
          title="You're not in this space"
          action={<Button variant="primary" icon="compose" href="/">Go home</Button>}
        >
          It's for its members. Someone who manages it can invite you; your spaces are in the
          sidebar.
        </EmptyState>
      </div>
    );
  }
  const tabs = tabsOf(ctx.resources.spaceTabs);
  const query = (ctx.hints.query ?? {}) as Record<string, string>;
  const tab = chosen(tabs, query.tab);
  const section = sectionOf(tab, query.tab);
  const manage = space.can.includes("manage");
  const waiting = manage ? (requests ?? []).length : 0;
  // Who's waiting to join, on what lets them in (and on the tab it's in).
  const counts: Record<string, number> = waiting ? { members: waiting } : {};
  const countOf = (t: (typeof tabs)[number]) =>
    (counts[t.key] ?? 0) + t.sections.reduce((n, s) => n + (counts[s.key] ?? 0), 0);
  // Its people by name, and whose it is (someone else's Personal).
  const names = namesIn(ctx, [
    ...members.map((m) => m.member),
    ...ownersOf([space], ctx.viewer?.name),
  ]);
  return (
    <SpaceHeader
      space={space}
      members={members}
      manage={manage}
      me={ctx.viewer?.name}
      call={ctx.call}
      names={names}
    >
      {style}
      <Title text={spaceName(space, ctx.viewer?.name, names)} />
      {space.archived ? <Archived space={space} manage={manage} call={ctx.call} /> : null}
      {tabs.length
        ? (
          <>
            <Tabs
              label={`${spaceName(space, ctx.viewer?.name, names)}'s tabs`}
              variant="line"
              className="space-tabs"
              value={tab?.key ?? ""}
              panel="space-tab"
              onChange={(key) => go(spacePath(id, key))}
              tabs={tabs.map((t) => ({
                value: t.key,
                label: t.title,
                ...(t.icon ? { icon: t.icon } : {}),
                ...(countOf(t) ? { count: countOf(t) } : {}),
                href: spacePath(id, t.key),
              }))}
            />
            <div
              id="space-tab"
              role="tabpanel"
              className="space-tab"
              data-tab={section?.key ?? tab?.key}
            >
              {tab && tab.sections.length
                ? (
                  <TabSections
                    tab={tab}
                    {...(section ? { section } : {})}
                    picked={!!section || query.open === "1"}
                    menu={tab.menu ?? "top"}
                    href={(key) => spacePath(id, key, key === tab.key)}
                    back={spacePath(id, tab.key)}
                    onPick={(key) => go(spacePath(id, key, key === tab.key))}
                    counts={counts}
                  >
                    {ctx.show((section ?? tab).view, { _id: id }, { in: id, mode: "page" })}
                  </TabSections>
                )
                : tab
                ? ctx.show(tab.view, { _id: id }, { in: id, mode: "page" })
                : null}
            </div>
          </>
        )
        : (
          <EmptyState icon="info" title="Nothing here yet" className="space-empty">
            This app adds nothing to a space's page.
          </EmptyState>
        )}
    </SpaceHeader>
  );
};

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** An archived space, said calmly: still readable, listed apart; Restore for those who manage it. */
function Archived(
  { space, manage, call }: { space: Reached; manage: boolean; call: Call },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Notice
      tone="neutral"
      icon="archive"
      className="space-archived"
      title={`${space.name} is archived`}
      action={manage
        ? (
          <Button
            size="sm"
            icon="restore"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                await call("space.archive", { space: space._id, archived: false });
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Restore
          </Button>
        )
        : null}
    >
      {error ?? "It stays readable, as it was, and it's listed apart, under Archived."}
    </Notice>
  );
}
