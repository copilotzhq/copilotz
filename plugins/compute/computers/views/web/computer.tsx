/**
 * One of the person's computers (kind `computer`, at `/computer/<id>`): its
 * name (renamed in place), whether it's online and when it was last seen,
 * what it is (system, host, where its spaces' folders are, the browser it
 * found), and forgetting it, behind a confirm; then its terminal, jobs and
 * files in one space's folder, the space they work in unless they pick
 * another (agents' jobs by their names: chat's `thread.agents`, for each
 * space it's in), with what its jobs serve (previews: `preview.here`, for
 * each space it's in). Live: it goes offline, and the page says so at once.
 * A cloud computer (a kind's, `computerKinds`) says its state as it
 * changes, and wakes when its page opens.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Button, EmptyState, Page, Skeleton, Title } from "../../../../../hosts/web/mod.ts";
import type { Computer } from "../../collections/computer.ts";
import type { Team } from "../../../../agents/chat/contract.ts";
import type { Desk } from "../../collections/desk.ts";
import type { Preview } from "../../collections/preview.ts";
import { jobActionsOf, kindByComputer, kindsOf, queryOf } from "./kinds.ts";
import { type Named, namedOf } from "./names.ts";
import { ComputerPage, type Space } from "./page.tsx";
import { STYLE } from "./style.ts";
import { namesIn } from "../../../../access/spaces/contract.ts";

export const computerView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const mine = ctx.db.collection("computer").query<Computer[]>("mine", {}).value;
  const spaces = ctx.db.collection("space").query<Space[]>("reached", {}).value;
  // Where it works: its desks, one per space it's in.
  const desks = item._id
    ? ctx.db.collection("desk").query<Desk[]>("of", { computer: item._id }).value
    : [];
  const here = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  // The agents answering in each space it's in, as they're named: whose its jobs are.
  const teams = [...new Set((desks ?? []).map((d) => d.in))].map((space) =>
    ctx.db.collection("thread").query<Team>("agents", { in: space }).value
  );
  const agents: Record<string, Named> = Object.assign(
    {},
    ...teams.map((team) => namedOf(team?.agents)),
  );
  // People by name, in the spaces it's in: who started its jobs.
  const members = desks?.length
    ? ctx.db.collection<{ member: string }>("member").find({
      space: { $in: [...new Set(desks.map((d) => d.in))] },
    }).value ?? []
    : [];
  const names = namesIn(ctx, members.map((m) => m.member).filter((m) => m.startsWith("person:")));
  // What it serves, at addresses of their own, in each space it's in.
  const previews = [...new Set((desks ?? []).map((d) => d.in))].flatMap((space) =>
    ctx.db.collection("preview").query<Preview[]>("here", { in: space }).value ?? []
  );
  // Its kind, a cloud computer's, from the kinds' own lists.
  const kinds = kindsOf(ctx.resources.computerKinds);
  const records = kinds.map((k) => {
    const [collection, query] = queryOf(k.mine)!;
    return ctx.db.collection(collection).query<{ _id: string }[]>(query, {}).value;
  });
  const style = <style href="computers-web" precedence="copilotz">{STYLE}</style>;
  if (
    mine === undefined || spaces === undefined || desks === undefined ||
    records.some((r) => r === undefined)
  ) {
    return (
      <Page title={<Skeleton width={200} height={30} />} width="lg">
        {style}
        <div className="computer-loading" aria-busy="true">
          <Skeleton height={20} width="60%" />
          <Skeleton height={380} radius="xl" />
        </div>
      </Page>
    );
  }
  const computer = mine.find((c) => c._id === item._id);
  if (!computer) {
    return (
      <div className="computer-gone">
        {style}
        <Title text="Not found" />
        <EmptyState
          icon="computer"
          heading="h1"
          title="This computer isn't here"
          action={
            <Button
              variant="primary"
              icon="compose"
              href={here ? `/?in=${encodeURIComponent(here)}` : "/"}
            >
              Go home
            </Button>
          }
        >
          It was forgotten, or it isn't yours. Your computers are in the sidebar.
        </EmptyState>
      </div>
    );
  }
  const kind = kindByComputer(kinds, records)[computer._id];
  return (
    <>
      {style}
      <ComputerPage
        key={computer._id}
        computer={computer}
        spaces={spaces}
        desks={desks}
        here={here}
        me={ctx.viewer?.name}
        agents={agents}
        names={names}
        call={ctx.call}
        {...(kind ? { kind } : {})}
        previews={previews}
        jobActions={jobActionsOf(ctx.resources.jobActions)}
      />
    </>
  );
};
