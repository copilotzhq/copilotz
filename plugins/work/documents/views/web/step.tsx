/**
 * An agent's call to a documents tool, in a conversation (kind
 * `document.step`, chat's `toolViews`): a write, an append or an edit as a
 * compact card (the document's title, what changed: +12 −3 lines, its
 * version, and Open); a read or a list as one quiet line, the document a
 * link. While it runs, it says what it's doing; what went wrong, it says
 * in the agent's own words.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { ShownCall, Thread } from "../../../../agents/chat/contract.ts";
import { Button, Icon, Spinner } from "../../../../../hosts/web/mod.ts";
import type { Document } from "../../contract.ts";
import { documentPath } from "../../shared/text.ts";
import { Counts } from "./changes.tsx";
import { STYLE } from "./style.ts";

/** What a write answered: the document, its version, and what changed. */
type Wrote = {
  id: string;
  title: string;
  version: number;
  added: number;
  removed: number;
  made?: boolean;
  unchanged?: boolean;
};

/** The document an answer links: `[Title](/document/<id>)`. */
const LINK = String.raw`\[(?<title>.*?)\]\(\/document\/(?<id>[\w-]+)\)`;

const WROTE = [
  new RegExp(String.raw`^Made ${LINK} \(version 1, (?<added>\d+) lines?\)`),
  new RegExp(
    String.raw`^Saved ${LINK} as version (?<version>\d+): \+(?<added>\d+) −(?<removed>\d+)`,
  ),
  new RegExp(String.raw`^No changes: ${LINK} is already that \(version (?<version>\d+)\)`),
];

/** What a write's answer says it did, if it did. */
export function wrote(output: string | undefined): Wrote | undefined {
  for (const [i, pattern] of WROTE.entries()) {
    const g = output?.match(pattern)?.groups;
    if (!g) continue;
    return {
      id: g.id,
      title: g.title,
      version: Number(g.version ?? 1),
      added: Number(g.added ?? 0),
      removed: Number(g.removed ?? 0),
      ...(i === 0 ? { made: true } : {}),
      ...(i === 2 ? { unchanged: true } : {}),
    };
  }
  return undefined;
}

const str = (value: unknown) => typeof value === "string" ? value : "";

export const documentStepView = (call: ShownCall, ctx: ViewContext<ReactNode>): ReactNode => {
  const running = ctx.hints.running === true;
  const output = call.output ?? "";
  const thread = typeof ctx.hints.thread === "string"
    ? ctx.db.collection<Thread>("thread").findOne({ _id: ctx.hints.thread }).value
    : undefined;
  const space = thread?.in;
  const id = output.match(/\/document\/([\w-]+)/)?.[1];
  const doc = id ? ctx.db.collection<Document>("document").findOne({ _id: id }).value : undefined;
  const style = <style href="documents-web" precedence="copilotz">{STYLE}</style>;
  const named = str(call.input?.title) || str(call.input?.document);
  const link = (title: string) =>
    id
      ? <a href={documentPath(id, space)} className="doc-step-link">{doc?.title ?? title}</a>
      : <b>{title}</b>;

  if (call.name === "list_documents") {
    const many = output.match(/^Documents here \((\d+)\)/)?.[1];
    return (
      <span className="doc-step-line">
        {style}
        {running ? <Spinner size={13} /> : <Icon name="file" size={14} />}
        <span>
          {running
            ? "Looking at this space's documents…"
            : many
            ? `Looked at this space's documents (${many})`
            : "Looked for documents here: there are none yet"}
        </span>
      </span>
    );
  }

  if (call.name === "read_document") {
    const version = output.match(/· version (\d+)/)?.[1];
    const title = output.match(/^\[(.*?)\]\(\/document\//)?.[1] ?? named;
    const ok = !running && !!id && !!version;
    return (
      <span className="doc-step-line">
        {style}
        {running
          ? <Spinner size={13} />
          : <Icon name={ok || running ? "file" : "alert"} size={14} />}
        <span>
          {running
            ? (
              <>
                Reading <b>{named}</b>…
              </>
            )
            : ok
            ? <>Read {link(title)} · version {version}</>
            : output}
        </span>
      </span>
    );
  }

  const verb = call.name === "append_document"
    ? { doing: "Adding to", done: "Added to" }
    : call.name === "edit_document"
    ? { doing: "Editing", done: "Edited" }
    : { doing: str(call.input?.document) ? "Rewriting" : "Writing", done: "Rewrote" };
  if (running) {
    return (
      <span className="doc-step-line">
        {style}
        <Spinner size={13} />
        <span>
          {verb.doing} <b>{named || "a document"}</b>…
        </span>
      </span>
    );
  }
  const w = wrote(output);
  if (!w) {
    return (
      <span className="doc-step-line" data-failed>
        {style}
        <Icon name="alert" size={14} />
        <span>{output || "It didn't finish."}</span>
      </span>
    );
  }
  return (
    <div className="doc-step">
      {style}
      <span className="doc-step-icon" aria-hidden="true">
        <Icon name="file" size={16} />
      </span>
      <span className="doc-step-text">
        <a href={documentPath(w.id, space)} className="doc-step-title">{doc?.title ?? w.title}</a>
        <span className="doc-step-what">
          {w.made ? "Made it" : w.unchanged ? "No changes" : verb.done + " it"} · version{" "}
          {w.version}
          {w.unchanged ? null : <Counts added={w.added} removed={w.removed} />}
          {doc === null ? <span>· since deleted</span> : null}
        </span>
      </span>
      {doc === null
        ? null
        : (
          <Button size="sm" variant="outline" iconEnd="external" href={documentPath(w.id, space)}>
            Open
          </Button>
        )}
    </div>
  );
};
