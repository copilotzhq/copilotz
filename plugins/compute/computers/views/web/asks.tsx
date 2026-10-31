/**
 * What agents wait on you for in this conversation (kind `computer.asks`,
 * shown over where you type: chat's `conversation` resource, with hints
 * `{ thread, working }`): a card each, "assistant wants to run `npm test`"
 * on which computer, with Allow once · Allow in this conversation · Always
 * allow · Deny (`computer.approve`, whose answer goes into the
 * conversation, and the agent carries on). A write shows what it will write
 * first (its `preview`: a new file's first lines, or an edit's change). What
 * it shows scrolls in a few lines of its own, however long (a command can
 * wrap into dozens), so the answers always show under it. The
 * cards wait for the agent's turn to be over (`working` false), so they
 * come once it has said why, gently; answered, one goes: `approval.pending`
 * is live. The agent shows as it's named (chat's `agentsShown`).
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  Button,
  Card,
  CodeBlock,
  Icon,
  type IconName,
  message,
  Time,
  Tooltip,
} from "../../../../../hosts/web/mod.ts";
import { agentsShown } from "../../../../agents/chat/contract.ts";
import type { Approval } from "../../collections/approval.ts";
import { addressOf, asked, previewOf, publishOf, reach, sentence } from "./asked.ts";
import { STYLE } from "./style.ts";

type Answer = "once" | "thread" | "always" | "deny";
type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

const ICONS: Record<string, IconName> = {
  terminal: "terminal",
  jobs: "play",
  writes: "pencil",
  publish: "globe",
};

export const asksView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  const thread = typeof ctx.hints.thread === "string" ? ctx.hints.thread : undefined;
  const pending = ctx.db.collection("approval").query<Approval[]>("pending", {}).value ?? [];
  const here = pending.filter((a) => a.thread === thread);
  // While the agent is still writing, its explanation comes first.
  if (!thread || !here.length || ctx.hints.working === true) return null;
  const agents = agentsShown(ctx, here.map((a) => a.agent));
  if (!agents) return null;
  return (
    <div className="asks" role="region" aria-label="Waiting on you">
      <style href="computers-web" precedence="copilotz">{STYLE}</style>
      {here.map((a) => {
        return (
          <Ask
            key={a._id}
            approval={{ ...a, agent: agents[a.agent]?.name || a.agent }}
            computer={a.name}
            call={ctx.call}
          />
        );
      })}
    </div>
  );
};

function Ask(
  { approval: a, computer, call }: { approval: Approval; computer?: string; call: Call },
): ReactNode {
  const [busy, setBusy] = useState<Answer>();
  const [error, setError] = useState<string>();
  const { wants, what, verb } = asked(a);
  // What a write would write, or an edit change.
  const preview = a.preview;
  const answer = async (said: Answer) => {
    setBusy(said);
    setError(undefined);
    try {
      await call("computer.approve", { approval: a._id, answer: said });
    } catch (e) {
      setError(message(e));
      setBusy(undefined);
    }
  };
  const allow = (said: Exclude<Answer, "deny">, label: string, variant: "primary" | "outline") => (
    <Tooltip text={reach(said, a, computer)}>
      <Button
        size="sm"
        variant={variant}
        loading={busy === said}
        disabled={!!busy}
        onClick={() => void answer(said)}
      >
        {label}
      </Button>
    </Tooltip>
  );
  return (
    <Card as="article" padding="none" className="ask" aria-label={sentence(a)}>
      <span className="ask-icon" aria-hidden="true">
        <Icon name={ICONS[a.work] ?? "tool"} size={16} />
      </span>
      <div className="ask-main">
        <p className="ask-head">
          <b>{a.agent}</b> {wants}
          <span className="ask-where">
            {computer ? <>on {computer} ·</> : null}
            <Time at={a.at} />
          </span>
        </p>
        {a.work === "publish" ? <Publish approval={a} /> : a.work === "writes" && preview
          ? (
            <CodeBlock
              className="ask-what ask-preview"
              title={<code>{what}</code>}
              code={previewOf(preview, verb)}
              height={8}
              label={`What it will write in ${what}`}
            />
          )
          : (
            <CodeBlock
              className="ask-what"
              code={a.work === "writes" ? what : [{ text: "$ ", tone: "muted" }, { text: what }]}
              height={6}
              copy={what}
              label={a.work === "writes" ? "The file" : "The command"}
            />
          )}
        <div className="ask-answers">
          {allow("once", "Allow once", "primary")}
          {allow("thread", "Allow in this conversation", "outline")}
          {allow("always", "Always allow", "outline")}
          <Button
            size="sm"
            variant="ghost"
            className="ask-deny"
            loading={busy === "deny"}
            disabled={!!busy}
            onClick={() => void answer("deny")}
          >
            Deny
          </Button>
        </div>
        {error ? <p role="alert" className="ask-error">{error}</p> : null}
      </div>
    </Card>
  );
}

/** What publishing would do: the app, where it'll be, what it's built from, and that it runs on its own. */
function Publish({ approval: a }: { approval: Approval }): ReactNode {
  const { name, job, port, path } = publishOf(a.detail);
  const at = addressOf(a);
  const from = [
    path ? `the folder ${path}` : "the space's folder",
    job ? `job ${job}` : undefined,
    port ? `port ${port}` : undefined,
  ].filter(Boolean).join(" · ");
  return (
    <div className="ask-publish">
      <p className="ask-publish-name">
        <b>{name}</b>
        {at ? <code className="ask-publish-at">{at.replace(/^https?:\/\//, "")}</code> : null}
      </p>
      <p className="ask-publish-from">
        From{" "}
        {from}. It's built and runs on its own, without this computer, at an address anyone can
        open.
      </p>
    </div>
  );
}
