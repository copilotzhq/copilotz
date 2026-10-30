/**
 * Over a chat's composer (kind `accounts.uses`, chat's `conversation`
 * resource), a quiet word when the agents answering there run on the
 * person's plan ("Runs on your ChatGPT Plus plan"), or would, but its
 * account needs reconnecting. Nothing otherwise. Who answers is the chat's
 * agents, else its space's (`thread.agents`, chat's); on what, the account
 * plugin says (`account.uses`), as the models plugin would try them. It
 * links to Connected accounts.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Icon, Tooltip } from "../../../../../hosts/web/mod.ts";
import type { Team } from "../../../../agents/chat/contract.ts";
import type { Uses } from "../../contract.ts";
import { STYLE } from "./style.ts";
import { usesLine } from "./words.ts";

export const accountsUsesView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const id = typeof ctx.hints.thread === "string" ? ctx.hints.thread : undefined;
  if (!id) return null;
  const thread = ctx.db.collection<{ agents?: string[]; in?: string }>("thread").findOne({
    _id: id,
  }).value;
  if (!thread) return null;
  const team = ctx.db.collection("thread").query<Team>("agents", {
    ...(thread.in ? { in: thread.in } : {}),
    ...(thread.agents?.length ? { names: [...thread.agents].sort() } : {}),
  }).value;
  if (!team) return null;
  const agents = (thread.agents?.length ? thread.agents : team.default).filter((a) =>
    team.agents[a]
  );
  if (!agents.length) return null;
  const models = Object.fromEntries(agents.map((a) => [a, team.agents[a].model]));
  const uses = ctx.db.collection("account").query<Uses>("uses", { models }).value;
  if (!uses) return null;
  const line = usesLine(uses, agents, (a) => team.agents[a]?.name ?? a);
  if (!line) return null;
  const use = Object.values(uses).find((u) => u.provider === line.provider);
  const whose = use?.label ?? `your ${use?.title} account`;
  const about = line.tone === "plan"
    ? `On ${whose}, not the app's API key. Manage it in Connected accounts.`
    : "Its sign-in needs you: reconnect it in Connected accounts.";
  return (
    <div className={`accounts-uses accounts-uses-${line.tone}`}>
      <style href="accounts-web" precedence="copilotz">{STYLE}</style>
      <Tooltip text={about}>
        <a href={line.tone === "plan" ? "/accounts" : `/accounts?connect=${line.provider}`}>
          <Icon name={line.tone === "plan" ? "sparkles" : "alert"} size={13} />
          <span>{line.text}</span>
        </a>
      </Tooltip>
    </div>
  );
};
