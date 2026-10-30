/**
 * Any kind without a web View of its own, as a detail page: its document
 * (read from the kind's collection when the address gives only its id, as
 * `/space/<id>` does), titled by its name, each field a row, labelled and
 * formatted as people read them, its id last. Nothing there, it says so. In
 * a side panel (`hints.mode: "panel"`), the same, tighter.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../runtime/mod.ts";
import {
  Badge,
  Button,
  DetailList,
  EmptyState,
  humanize,
  Page,
  Title,
} from "../../../../hosts/web/mod.ts";

type Doc = Record<string, unknown>;

/** The fields a document goes by, if it has one: what titles its page. */
const NAMES = ["title", "name", "label", "subject"];

export const defaultView = (item: unknown, ctx: ViewContext<ReactNode>): ReactNode => {
  if (item === null || typeof item !== "object") return <span>{String(item ?? "")}</span>;
  const given = item as Doc;
  const address = Object.keys(given).length === 1 && typeof given._id === "string";
  const doc = address
    ? ctx.db.collection<Doc>(ctx.kind).findOne({ _id: given._id as string }).value
    : given;
  if (doc === undefined) return null;
  const fields = Object.keys(doc ?? {}).filter((key) => key !== "_id");
  if (!doc || !fields.length) {
    return (
      <div className="copilotz-shell-empty">
        <Title text="Nothing to show" />
        <EmptyState
          icon="search"
          heading="h1"
          title="Nothing to show"
          action={<Button href="/" icon="compose">Go home</Button>}
        >
          There's no page for this here, or it isn't shared with you.
        </EmptyState>
      </div>
    );
  }
  const kind = humanize(ctx.kind);
  const named = NAMES.find((key) => typeof doc[key] === "string" && doc[key]);
  const title = named ? String(doc[named]) : kind;
  return (
    <Page
      title={title}
      icon="file"
      badges={named ? <Badge>{kind}</Badge> : null}
      density={ctx.hints.mode === "panel" ? "panel" : "full"}
    >
      <Title text={title} />
      <DetailList
        item={doc}
        fields={[
          ...fields.filter((key) => key !== named),
          ...(typeof doc._id === "string" ? ["_id"] : []),
        ]}
      />
    </Page>
  );
};
