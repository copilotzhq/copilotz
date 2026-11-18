/**
 * The org's team, on its page's Agents section (under the tiers): the agents
 * every space in the org starts with, each with its kind of work and the
 * model that gives it on the org's default tier. The app's agents as the org
 * has them (as they are, or changed: "Changed"), then those the org made
 * ("Your org's"). Owners and admins add one (team's `agent.org`, in a
 * dialog), edit one (its page, `?edit=1`), take one off the team
 * (`agent.delete`, after a question: it leaves every space) and put one of
 * the app's back (`agent.restore`) or back as the app has it
 * (`agent.reset`). Anyone else reads it. Models are the tiers', set by kind
 * of work above it, never per agent.
 */
import { type ReactNode, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Dialog,
  LazyView,
  Menu,
  type MenuItem,
  message,
  Notice,
  Skeleton,
} from "copilotz/web";
import type { Shown } from "../../contract.ts";
import { say } from "./say.ts";
import { sayText } from "copilotz/web/words";
import { modelSaid } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** An agent of the org's team, as team's `agent.team` query answers. */
export type TeamAgent = {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  kind: "app" | "changed" | "org";
  off?: true;
  like?: string;
  model?: string;
};

/** A description's first sentence. */
const firstSentence = (text?: string) => {
  if (!text) return undefined;
  const end = text.search(/[.!?](\s|$)/);
  return end > 0 ? text.slice(0, end + 1) : text;
};

/** The kind of work an agent of the team does: its own, what it works like, else the first. */
export function kindFor(shown: Shown, agent: Pick<TeamAgent, "id" | "like">): string | undefined {
  const kinds = shown.kinds.map((k) => k.kind);
  if (agent.like && kinds.includes(agent.like)) return agent.like;
  const own = shown.kinds.find((k) => k.agents.some((a) => a.agent === agent.id));
  return own?.kind ?? kinds[0];
}

export function Team(
  { shown, team, may, org, tier, call }: {
    shown: Shown;
    team?: TeamAgent[];
    may: boolean;
    org?: string;
    /** The org's default tier: what each agent's model is shown on. */
    tier: string;
    call: Call;
  },
): ReactNode {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<TeamAgent>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  if (!team) return <Skeleton height={260} radius="xl" />;

  const onTier = shown.tiers.find((t) => t.name === tier);
  const on = team.filter((a) => !a.off);
  const off = team.filter((a) => a.off);
  const act = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError(undefined);
    try {
      await work();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  const menuOf = (agent: TeamAgent): ReactNode => {
    if (!may) return null;
    const items: (MenuItem | "separator")[] = [
      { label: say("edit"), icon: "pencil", href: `/agent/${encodeURIComponent(agent.id)}?edit=1` },
      ...(agent.kind === "changed"
        ? [{
          label: say("backToOriginal"),
          icon: "restore" as const,
          onSelect: () => void act(agent.id, () => call("agent.reset", { agent: agent.id })),
        }]
        : []),
      "separator",
      {
        label: say("removeFromTeam"),
        icon: "trash",
        tone: "destructive",
        onSelect: () => setRemoving(agent),
      },
    ];
    return <Menu label={say("tierMore", { tier: agent.name })} align="end" items={items} />;
  };
  return (
    <Card as="section" className="tiers-agents" aria-labelledby="tiers-team">
      <div className="tiers-agents-head">
        <div>
          <h3 id="tiers-team">{say("teamTitle")}</h3>
          <p>{org ? say("teamAbout", { org }) : say("teamAboutMine")}</p>
        </div>
        {may
          ? (
            <div className="tiers-agents-actions">
              <Button size="sm" variant="secondary" icon="plus" onClick={() => setAdding(true)}>
                {say("addAgent")}
              </Button>
            </div>
          )
          : null}
      </div>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      <ul className="tiers-rows">
        {on.map((agent) => {
          const kind = kindFor(shown, agent);
          const kindTitle = shown.kinds.find((k) => k.kind === kind)?.title;
          const model = onTier?.kinds.find((k) => k.kind === kind)?.model;
          return (
            <li key={agent.id} className="tiers-row" aria-busy={busy === agent.id || undefined}>
              <Avatar name={agent.name} kind="agent" icon={agent.icon} size={32} />
              <div className="tiers-row-text">
                <p className="tiers-row-name">
                  {agent.name}
                  <span className="tiers-row-handle">@{agent.id}</span>
                  {agent.kind === "changed"
                    ? <Badge variant="outline">{say("badgeChanged")}</Badge>
                    : null}
                  {agent.kind === "org" ? <Badge tone="primary">{say("badgeOrgs")}</Badge> : null}
                </p>
                {agent.description
                  ? <p className="tiers-row-about">{firstSentence(sayText(agent.description))}</p>
                  : null}
                <p className="tiers-row-model">
                  {kindTitle ? <span className="tiers-row-kind">{kindTitle}</span> : null}
                  {model
                    ? say.nodes("onTier", {
                      model: <b>{modelSaid(model)}</b>,
                      tier: onTier?.title ?? "",
                    })
                    : null}
                </p>
              </div>
              <span className="tiers-row-end">{menuOf(agent)}</span>
            </li>
          );
        })}
      </ul>
      {off.length
        ? (
          <div className="tiers-off">
            <h4>{say("notOnTeam")}</h4>
            {off.map((agent) => (
              <div key={agent.id} className="tiers-off-row">
                <Avatar name={agent.name} kind="agent" icon={agent.icon} size={24} />
                <span className="tiers-off-text">
                  {agent.name}
                  {agent.description ? `: ${firstSentence(sayText(agent.description))}` : ""}
                </span>
                {may
                  ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="plus"
                      loading={busy === agent.id}
                      onClick={() =>
                        void act(agent.id, () => call("agent.restore", { agent: agent.id }))}
                    >
                      {say("addBack")}
                    </Button>
                  )
                  : null}
              </div>
            ))}
          </div>
        )
        : null}
      {may
        ? (
          <>
            <Dialog
              open={adding}
              onClose={() => setAdding(false)}
              size="lg"
              title={say("addAgentTitle")}
              description={org ? say("addAgentAbout", { org }) : say("addAgentAboutMine")}
            >
              {adding
                ? (
                  <LazyView
                    kind="agent.org"
                    hints={{
                      done: () => setAdding(false),
                      kinds: shown.kinds.map((k) => ({
                        kind: k.kind,
                        title: k.title,
                        agents: k.agents.map((a) => a.name),
                      })),
                    }}
                    fallback={<Skeleton height={320} radius="lg" />}
                  />
                )
                : null}
            </Dialog>
            <Dialog
              open={!!removing}
              onClose={() => setRemoving(undefined)}
              size="sm"
              title={removing ? say("removeTitle", { name: removing.name }) : ""}
              footer={
                <>
                  <Button variant="ghost" onClick={() => setRemoving(undefined)}>
                    {say("cancel")}
                  </Button>
                  <Button
                    variant="destructive"
                    loading={!!removing && busy === removing.id}
                    onClick={() => {
                      const agent = removing!;
                      void act(agent.id, () => call("agent.delete", { agent: agent.id })).then(() =>
                        setRemoving(undefined)
                      );
                    }}
                  >
                    {say("remove")}
                  </Button>
                </>
              }
            >
              {removing
                ? (
                  <p className="tiers-remove-said">
                    {org
                      ? say("removeSaid", { name: removing.name, org })
                      : say("removeSaidMine", { name: removing.name })}{" "}
                    {removing.kind === "org" ? say("removeDeletes") : say("removeBack")}
                  </p>
                )
                : null}
            </Dialog>
          </>
        )
        : null}
    </Card>
  );
}
