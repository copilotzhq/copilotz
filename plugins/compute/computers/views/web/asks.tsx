/**
 * What an agent asks to do on a computer, on its card in a conversation
 * (kind `computer.ask`, chat's `askViews` for a computer's kinds of work;
 * chat draws the card and its answers: once, for this conversation, for the
 * routine that set it going, always, or no, as the ask takes them). Given the
 * approval, and hints `{ agent, aside }` (the agent as it's named; asked in a
 * side thread): "assistant wants to run" on which computer, when, then what:
 * the command; a write, what it will write first (its `preview`: a new file's
 * first lines, or an edit's change); publishing, the app, where it'll be,
 * and what it's built from. What it shows scrolls in a few lines of its own,
 * however long (a command can wrap into dozens), so the answers always show
 * under it.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { CodeBlock, Time } from "../../../../../hosts/web/mod.ts";
import type { Approval } from "../../../../agents/chat/contract.ts";
import { addressOf, asked, previewOf, publishOf } from "./asked.ts";
import { STYLE } from "./style.ts";

export const askView = (a: Approval, ctx: ViewContext<ReactNode>): ReactNode => {
  const agent = typeof ctx.hints.agent === "string" ? ctx.hints.agent : a.agent;
  const { wants, what, verb } = asked(a);
  return (
    <>
      <style href="computers-web" precedence="copilotz">{STYLE}</style>
      <p className="ask-head">
        <b>{agent}</b> {wants}
        <span className="ask-where">
          {a.name ? <>on {a.name} ·</> : null}
          {ctx.hints.aside === true ? <>in a side thread ·</> : null}
          <Time at={a.at} />
        </span>
      </p>
      {a.work === "publish" ? <Publish approval={a} /> : a.work === "writes" && a.preview
        ? (
          <CodeBlock
            className="ask-what ask-preview"
            title={<code>{what}</code>}
            code={previewOf(a.preview, verb)}
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
    </>
  );
};

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
