/**
 * The screen: the root View. It reads where you are and what your commands
 * printed, and composes what's open (through that kind's View), the
 * scrollback, what waits on you (the `notices` resource's Views) and where
 * you type. A plugin replaces any of these by registering its own View for
 * that kind.
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Notices, Printed, ShellState } from "../../../../hosts/terminal/contract.ts";
import { Composer } from "../../../../hosts/terminal/composer.tsx";
import { Scrollback } from "../../../../hosts/terminal/scrollback.tsx";

export const shellView = (item: { person: string }, ctx: ViewContext<ReactNode>) => {
  const state = ctx.db.collection<ShellState>("shell").query<ShellState>("mine", {
    person: item.person,
  }).value ?? { _id: item.person };
  const since = ctx.hints.since as string | undefined;
  const printed = ctx.db.collection<Printed>("output").find(
    { person: item.person, ...(since ? { at: { $gte: since } } : {}) },
    { sort: { at: 1 } },
  );
  const banner = ctx.hints.banner as string | undefined;
  const notices = Object.entries((ctx.resources.notices ?? {}) as Notices)
    .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))
    .map(([name, notice]) => [name, ctx.show(notice.view, { person: item.person })] as const)
    .filter(([, shown]) => shown !== undefined && shown !== null && shown !== "");
  return (
    <>
      <Scrollback
        entries={banner ? [{ key: "banner", node: <Text dimColor>{banner}</Text> }] : []}
      />
      {state.open ? ctx.show(state.open.kind, state.open.item) : null}
      <Scrollback
        entries={(printed.value ?? []).map((p) => ({
          key: p._id,
          node: p.kind ? ctx.show(p.kind, p.item, p.hints) : p.text,
        }))}
      />
      {notices.map(([name, shown]) => (
        <Box key={name} marginTop={1}>
          {typeof shown === "string" ? <Text>{shown}</Text> : shown}
        </Box>
      ))}
      <Composer prompt={ctx.show("prompt", { state, me: item.person })} />
    </>
  );
};
