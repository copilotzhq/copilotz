/**
 * An agent reading a skill, in a conversation (kind `skill.step`, chat's
 * `toolViews` for `read_skill`): one quiet line, "Read the weekly-report
 * skill" (or one of its files), the skill a link to its page; "Reading…"
 * while it runs; what went wrong, when it did.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Icon, Spinner } from "../../../../../hosts/web/mod.ts";
import type { ShownCall, Thread } from "../../../chat/contract.ts";
import type { Shown } from "../../shared/skills.ts";
import { skillPath } from "./skills.ts";
import { STYLE } from "./style.ts";

export const skillStepView = (call: ShownCall, ctx: ViewContext<ReactNode>): ReactNode => {
  const name = String(call.input?.name ?? "");
  const file = typeof call.input?.file === "string" && call.input.file
    ? call.input.file
    : undefined;
  const thread = typeof ctx.hints.thread === "string"
    ? ctx.db.collection<Thread>("thread").findOne({ _id: ctx.hints.thread }).value
    : undefined;
  const space = thread?.in;
  const listed = space
    ? ctx.db.collection("skill").query<Shown[]>("list", { in: space }).value
    : undefined;
  const found = listed?.find((s) => s.name === name);
  const running = ctx.hints.running === true;
  const failed = !running && /^(No skill|"[^"]+" has no file)/.test(call.output ?? "");
  const what = found
    ? <a href={skillPath(found._id, space)}>{name}</a>
    : <b className="skill-handle">{name}</b>;
  return (
    <span className="skill-step">
      <style href="skills-web" precedence="copilotz">{STYLE}</style>
      {running ? <Spinner size={14} /> : <Icon name="tool" size={14} />}
      {failed ? <span>{call.output}</span> : file
        ? (
          <span>
            {running ? "Reading" : "Read"} <b className="skill-handle">{file}</b> from {what}
          </span>
        )
        : <span>{running ? "Reading the" : "Read the"} {what} skill</span>}
    </span>
  );
};
