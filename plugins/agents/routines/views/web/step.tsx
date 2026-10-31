/**
 * A routine an agent made from a conversation (kind `routine.step`, chat's
 * `toolViews` for `schedule_routine`): a small card, the routine as it is
 * now (what it's called, when it runs, whom it runs as, paused or not),
 * opening its page, so the person sees at once what was set up to run as
 * them, and can change or stop it there; "Setting up a routine…" while it
 * runs; what went wrong when it did, and that it's gone once deleted.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Badge, Button, Icon, Spinner } from "../../../../../hosts/web/mod.ts";
import type { ShownCall } from "../../../chat/contract.ts";
import type { Routine } from "../../collections/routine.ts";
import { describe, localZone } from "../../shared/schedule.ts";
import { routinePath } from "./routines.ts";
import { STYLE } from "./style.ts";
import { nameOf, namesIn } from "../../../../access/spaces/contract.ts";

export const routineStepView = (call: ShownCall, ctx: ViewContext<ReactNode>): ReactNode => {
  const style = <style href="routines-web" precedence="copilotz">{STYLE}</style>;
  const output = call.output ?? "";
  const id = output.startsWith("Made it") ? /\[([\w-]{8,})\]/.exec(output)?.[1] : undefined;
  const routine = id ? ctx.db.collection<Routine>("routine").findOne({ _id: id }).value : null;
  if (ctx.hints.running === true || routine === undefined) {
    return (
      <span className="routine-step-plain">
        {style}
        <Spinner size={14} /> Setting up a routine…
      </span>
    );
  }
  if (!id) {
    return (
      <span className="routine-step-plain">
        {style}
        <Icon name="alert" size={14} /> {output || "No routine was made."}
      </span>
    );
  }
  if (!routine) {
    return (
      <span className="routine-step-plain">
        {style}
        <Icon name="refresh" size={14} /> A routine was made here, and has since been deleted.
      </span>
    );
  }
  const me = ctx.viewer?.name;
  const names = namesIn(ctx, [routine.by]);
  return (
    <div className="routine-step">
      {style}
      <span className="routine-step-mark">
        <Icon name="refresh" size={16} />
      </span>
      <span className="routine-step-text">
        <b>
          {routine.name} {routine.paused ? <Badge>Paused</Badge> : null}
        </b>
        <span>
          {describe(routine.schedule, { here: localZone() })} · runs as{" "}
          {routine.by === me ? "you" : nameOf(routine.by, names)}
        </span>
      </span>
      <Button size="sm" iconEnd="chevron" href={routinePath(routine._id)}>Open</Button>
    </div>
  );
};
