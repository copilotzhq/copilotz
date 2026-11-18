/**
 * Making an agent for the org's team (kind `agent.org`, hints `{ done?,
 * kinds? }`): for its owners and admins, on the org's page. First what it
 * should do, and Compass drafts the rest (`Describe`, `agent.sketch`), or
 * they fill it in. Then its fields (`AgentFields`), with its kind of work in
 * place of a model where tiers give agents theirs (`kinds`); else a model.
 * Made (`agent.create`, the org's: `in: "*"`), it joins every space in use
 * and every new one; `done()` is called with its id.
 */
import { type ReactNode, useId, useState } from "react";
import type { ViewContext } from "copilotz";
import { Button, message, Skeleton } from "copilotz/web";
import type { Agent } from "copilotz/plugins/agents/contract";
import { AgentFields, type Draft } from "./agent-fields.tsx";
import { Describe, KindField, type KindOption } from "./agent-describe.tsx";
import { handleOf, type Options, usualTools } from "./agents.ts";
import { STYLE } from "./style.ts";
import { say } from "./words.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** The org's own, as the access plugin keeps it: the org itself. */
const ORG = "*";

export const agentOrgView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const known = ctx.db.collection("agent").query<Record<string, Agent>>("known", {}).value;
  const options = ctx.db.collection("agent").query<Options>("options", {}).value;
  const done = typeof ctx.hints.done === "function"
    ? ctx.hints.done as (agent: string) => void
    : undefined;
  const kinds = Array.isArray(ctx.hints.kinds) ? ctx.hints.kinds as KindOption[] : undefined;
  return (
    <>
      <style href="team-web" precedence="copilotz">{STYLE}</style>
      {known && options
        ? <OrgAgent known={known} options={options} kinds={kinds} call={ctx.call} done={done} />
        : <Skeleton height={320} radius="lg" />}
    </>
  );
};

function OrgAgent(
  { known, options, kinds, call, done }: {
    known: Record<string, Agent>;
    options: Options;
    kinds?: KindOption[];
    call: Call;
    done?(agent: string): void;
  },
): ReactNode {
  const id = useId();
  const offered = options.tools.map((t) => t.name);
  const [step, setStep] = useState<"describe" | "form">("describe");
  const [draft, setDraft] = useState<Draft>(() => ({
    name: "",
    icon: "",
    description: "",
    instructions: "",
    model: options.models[0] ?? "",
    tools: usualTools(known, offered),
  }));
  const [like, setLike] = useState(kinds?.[0]?.kind ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = draft.name.trim();
  const handle = name ? handleOf(name, (taken) => taken in known) : "";
  if (step === "describe") {
    return (
      <Describe
        kinds={kinds}
        call={call}
        onSkip={() => setStep("form")}
        onDraft={(sketch) => {
          setDraft((now) => ({
            ...now,
            name: sketch.name,
            icon: sketch.icon,
            description: sketch.description,
            instructions: sketch.instructions,
          }));
          if (sketch.like) setLike(sketch.like);
          setStep("form");
        }}
      />
    );
  }
  return (
    <form
      className="agent-new"
      aria-label={say("orgForm")}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name || busy) return;
        setBusy(true);
        setError(undefined);
        try {
          const { agent } = await call<{ agent: string }>("agent.create", {
            in: ORG,
            name,
            ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
            ...(draft.instructions.trim() ? { instructions: draft.instructions.trim() } : {}),
            tools: draft.tools,
            ...(draft.icon ? { icon: draft.icon } : {}),
            ...(kinds?.length ? (like ? { like } : {}) : { model: draft.model }),
          });
          done?.(agent);
        } catch (e) {
          setError(message(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <AgentFields
        value={draft}
        onChange={(patch) => setDraft((now) => ({ ...now, ...patch }))}
        options={options}
        handle={handle}
        call={call}
        autoFocus
        model={kinds?.length
          ? <KindField kinds={kinds} value={like} onChange={setLike} disabled={busy} />
          : undefined}
      />
      <div className="agent-new-end">
        <p id={`${id}-said`} className="agent-form-note" aria-live="polite">
          {error ? <span className="agent-error" role="alert">{error}</span> : say("orgJoins")}
        </p>
        <Button variant="ghost" onClick={() => setStep("describe")} disabled={busy}>
          {say("back")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          icon="plus"
          loading={busy}
          disabled={!name}
          aria-describedby={`${id}-said`}
        >
          {name ? say("addToTeamNamed", { name }) : say("addToTeam")}
        </Button>
      </div>
    </form>
  );
}
